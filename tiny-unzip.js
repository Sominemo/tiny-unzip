// author: Sergey Dilong
//
// Useful links:
// spec: https://www.iana.org/assignments/media-types/application/zip
// https://medium.com/@felixstridsberg/the-zip-file-format-6c8a160d1c34
// https://stackoverflow.com/questions/8593904/how-to-find-the-position-of-central-directory-in-a-zip-file
// https://github.com/whatwg/compression/issues/39


// terminology:
// local file entity: headers encoded inlined right before the file data
// central directory entity: headers encoded in the very end of the archive
// end of central directory entity: marks the end of central directory and contains metadata about the central directory
// data descriptor entity: optional entity that contains metadata about the file data, goes after the file data
export class ZipReader {
    constructor(arrayBuffer) {
        this.index = 0;
        this.localFiles = [];
        this.centralDirectories = [];
        this.endOfCentralDirectory = undefined;

        this.dataView = new DataView(arrayBuffer);
    }
    async extract(entry, type = "") {
        let centralDirectory = entry;
        if (entry[ZipReader.structTypeSymbol] === "centralDirectory") {
            // if given a central directory entry, we need to find the local file entry from the offset
            entry = this.readLocalFile(entry.offset);
        }

        // console.log("Extracting", entry, entry.compressedSize || centralDirectory.compressedSize);

        const buffer = this.dataView.buffer.slice(
            entry.startsAt,
            // if the entry doesn't provide compressed size, we need to use the central directory entry
            entry.startsAt + (entry.compressedSize || centralDirectory.compressedSize)
        );

        if (entry.compressionMethod === 0x00) {
            // no compression
            return new Blob([buffer]);
        } else if (entry.compressionMethod === 0x08) {
            // deflate
            const decompressionStream = new DecompressionStream("deflate-raw");
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(buffer);
                    controller.close();
                }
            });
            const readable = stream.pipeThrough(decompressionStream);

            const reader = readable.getReader();
            let done = false;
            const data = [];

            while (!done) {
                const result = await reader.read();
                done = result.done;
                if (result.value) {
                    data.push(result.value);
                }
            }

            return new Blob(data, { type });
        } else {
            throw new Error("Unsupported compression method");
        }
    }
    entryByFileName(name, useCentralDirectory = true) {
        // find an entry by file name
        // if useCentralDirectory is true, it will search in central directory instead of local files

        let heap = useCentralDirectory ? this.centralDirectories : this.localFiles;

        for (let i = 0; i < heap.length; i++) {
            if (heap[i].fileName === name) {
                return heap[i];
            }
        }

        return undefined;
    }
    async extractByFileName(name, useCentralDirectory = true) {
        const entry = this.entryByFileName(name, useCentralDirectory);
        if (!entry) {
            return undefined;
        }

        return await this.extract(entry);
    }

    async read(useCentralDirectory = false) {

        // you can enable useCentralDirectory to re-scan the whole archive using central directory
        // if you couldn't do it the first time due to missing compressed size in local file headers
        if (useCentralDirectory) {
            this.index = 0;
            this.localFiles = [];
        }

        // until we reach the end of central directory or the end of the file
        while (this.index + 4 < this.dataView.byteLength) {
            const signature = this.dataView.getUint32(this.index, true);

            if (signature === 0x04034b50) { //local file
                const entry = this.readLocalFile(this.index);
                this.localFiles.push(entry);
                this.index += entry.startsAt + entry.compressedSize;

                // console.log("Local file", entry);

                if (entry.needsDataDescriptor) {
                    if (useCentralDirectory) {
                        // if we're using central directory, we can proceed using the central directory entry
                        // console.log("Jumping using central directory");
                        this.index += this.entryByFileName(entry.fileName, true).compressedSize;
                        continue;
                    }

                    // if the entry set a flag telling it's incomplete,
                    // we can't proceed with parsing
                    // console.log("Needs data descriptor");
                    break;
                }
            } else if (signature === 0x08074b50) { //data descriptor
                const entry = this.readDataDescriptor(this.index);
                const target = this.localFiles[this.localFiles.length - 1]
                target.crc = entry.crc;
                target.compressedSize = entry.compressedSize;
                target.uncompressedSize = entry.uncompressedSize;
                target.enrichedByDataDescriptor = true;
                this.index += entry[ZipReader.totalLengthSymbol];

                //console.log("Data descriptor", entry);
            } else if (useCentralDirectory) {
                //console.log("Finished reading local files");
                // if we're using central directory and meet any other signature,
                // it means we're done with local files and don't need to proceed
                break;
            } else if (signature === 0x02014b50) { //central directory
                const entry = this.readCentralDirectory(this.index);
                this.centralDirectories.push(entry);
                this.index += entry[ZipReader.totalLengthSymbol];

                //console.log("Central directory", entry);
            } else if (signature === 0x06054b50) { //end of central directory
                this.endOfCentralDirectory = this.readEndCentralDirectory(this.index);
                this.index += this.endOfCentralDirectory[ZipReader.totalLengthSymbol];

                //console.log("End of central directory", this.endOfCentralDirectory);
                break;
            } else {
                console.info("Unknown ZIP signature", signature, "at", this.index);
                break;
            }
        }

        if (useCentralDirectory) {
            // if we're using central directory, we need to re-scan the whole archive
            return;
        }

        // this function will take an offset that might be the first byte of the end of central directory
        // and will try to verify it by checking if its values make sense
        const heuristicsCentralDirectorySearch = (offset) => {
            const signature = this.dataView.getUint32(offset, true);

            if (signature === 0x06054b50) {
                //console.log("signature matches");
                // the signature matches

                const endOfCentralDirectory = this.readEndCentralDirectory(offset);
                if (endOfCentralDirectory[ZipReader.totalLengthSymbol] === this.dataView.byteLength - offset) {
                    //console.log("Offset matches");

                    // the end of central directory contains a comment field, which means
                    // it also has a comment length field declared. We can use the variable
                    // nature of the block, that is supposed to go until the end of the file,
                    // to verify if it's a real end of central directory.
                    // 
                    // totalLengthSymbol contains the total length of the block, including 
                    // the comment. It should match the remaining bytes of the file relative
                    // to the beginning of the block.

                    if (this.dataView.getUint32(endOfCentralDirectory.centralDirectoryOffset, true) === 0x02014b50) {
                        // console.log("FOUND: Central directory signature matches", offset);

                        // The end of central directory also contains the offset of the 
                        // beginning of the central directory. We can read the data
                        // on that offset, and if the signature will correspond to the
                        // beginning of the central directory block, it means we found
                        // the correct end of central directory mark.
                        this.endOfCentralDirectory = endOfCentralDirectory;

                        let readOffset = endOfCentralDirectory.centralDirectoryOffset;

                        // read central directory entries
                        while (readOffset < offset) {
                            const centralDirectory = this.readCentralDirectory(readOffset);
                            this.centralDirectories.push(centralDirectory);
                            readOffset += centralDirectory[ZipReader.totalLengthSymbol];
                        }
                        return true;
                    }
                }
            }

            return false;
        }

        // heuristics to find the end of central directory
        if (!this.endOfCentralDirectory) {
            // console.log("Heuristics to find the end of central directory");

            // There's a high chance that the end of central directory is located
            // right at the end of file with empty comment. The length of the block
            // with 0-length comment is 22 bytes, so the signature should be 
            // located at eof - 22.
            const hotSpots = [this.dataView.byteLength - 22];

            // There's also a high chance 64k is reserved for the comment at the end
            // of the file, so we can check that spot as well if the file is big enough.
            const jumpPos = this.dataView.byteLength - 64 * 1024 - 22;
            if (jumpPos > 0) {
                hotSpots.push(jumpPos);
            }

            for (let i = 0; i < hotSpots.length; i++) {
                // console.log("Checking hot spot", hotSpots[i]);
                if (heuristicsCentralDirectorySearch(hotSpots[i])) {
                    break;
                }
            }
        }

        // brute force to find the end of central directory
        // If no hot spots worked, we should seek the whole file from the end
        // until the last properly scanned offset we've reached from the beginning.
        this.backwardIndex = this.dataView.byteLength - 23;
        while (!this.endOfCentralDirectory && this.backwardIndex > 0 && this.backwardIndex > this.index) {
            if (heuristicsCentralDirectorySearch(this.backwardIndex)) {
                break;
            }

            this.backwardIndex--;
        }

    }
    readStruct(fields, offset) {
        const struct = {};
        let totalLength = 0;

        for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            if (typeof field.length === "number") {
                let bitLength = field.length * 8;

                switch (bitLength) {
                    case 8:
                        struct[field.name] = this.dataView.getUint8(offset + totalLength);
                        break;
                    case 16:
                        struct[field.name] = this.dataView.getUint16(offset + totalLength, true);
                        break;
                    case 32:
                        struct[field.name] = this.dataView.getUint32(offset + totalLength, true);
                        break;
                    case 64:
                        struct[field.name] = this.dataView.getBigUint64(offset + totalLength, true);
                        break;
                    default:
                        throw new Error("Unsupported length");
                }

                totalLength += field.length;
            } else {
                const str = [];
                for (let i = 0; i < struct[field.length]; i++) {
                    str.push(String.fromCharCode(this.dataView.getUint8(offset + totalLength + i)));
                }
                struct[field.name] = str.join("");

                totalLength += struct[field.length];
            }
        }

        struct[ZipReader.totalLengthSymbol] = totalLength;
        return struct;
    }
    readLocalFile(offset) {
        const fields = [
            {
                name: "signature",
                length: 4
            },
            {
                name: "version",
                length: 2
            },
            {
                name: "generalPurpose",
                length: 2
            },
            {
                name: "compressionMethod",
                length: 2
            },
            {
                name: "lastModifiedTime",
                length: 2
            },
            {
                name: "lastModifiedDate",
                length: 2
            },
            {
                name: "crc",
                length: 4
            },
            {
                name: "compressedSize",
                length: 4
            },
            {
                name: "uncompressedSize",
                length: 4
            },
            {
                name: "fileNameLength",
                length: 2
            },
            {
                name: "extraLength",
                length: 2
            },
            {
                name: "fileName",
                length: "fileNameLength"
            },
            {
                name: "extra",
                length: "extraLength"
            }
        ];

        const entry = this.readStruct(fields, offset);
        entry[ZipReader.structTypeSymbol] = "localFile";

        // if general purpose bit 3 is set
        // the file needs a data descriptor
        // and can't provide the compressed size beforehand
        if (entry.generalPurpose & 0x08) {
            entry.needsDataDescriptor = true;
        }

        entry.startsAt = offset + entry[ZipReader.totalLengthSymbol];
        entry.extract = this.extract.bind(this, entry);

        return entry;
    }
    readCentralDirectory(offset) {
        const fields = [
            {
                name: "signature",
                length: 4
            },
            {
                name: "versionCreated",
                length: 2
            },
            {
                name: "versionNeeded",
                length: 2
            },
            {
                name: "generalPurpose",
                length: 2
            },
            {
                name: "compressionMethod",
                length: 2
            },
            {
                name: "lastModifiedTime",
                length: 2
            },
            {
                name: "lastModifiedDate",
                length: 2
            },
            {
                name: "crc",
                length: 4
            },
            {
                name: "compressedSize",
                length: 4
            },
            {
                name: "uncompressedSize",
                length: 4
            },
            {
                name: "fileNameLength",
                length: 2
            },
            {
                name: "extraLength",
                length: 2
            },
            {
                name: "fileCommentLength",
                length: 2
            },
            {
                name: "diskNumber",
                length: 2
            },
            {
                name: "internalAttributes",
                length: 2
            },
            {
                name: "externalAttributes",
                length: 4
            },
            {
                name: "offset",
                length: 4
            },
            {
                name: "fileName",
                length: "fileNameLength"
            },
            {
                name: "extra",
                length: "extraLength"
            },
            {
                name: "comments",
                length: "fileCommentLength"
            }
        ];

        const centralDirectory = this.readStruct(fields, offset);
        centralDirectory[ZipReader.structTypeSymbol] = "centralDirectory";

        return centralDirectory;
    }
    readDataDescriptor(offset) {
        const fields = [
            {
                name: "signature",
                length: 4
            },
            {
                name: "crc",
                length: 4
            },
            {
                name: "compressedSize",
                length: 4
            },
            {
                name: "uncompressedSize",
                length: 4
            }
        ];

        const dataDescriptor = this.readStruct(fields, offset);
        dataDescriptor[ZipReader.structTypeSymbol] = "dataDescriptor";

        return dataDescriptor;
    }
    readEndCentralDirectory(offset) {
        const fields = [
            {
                name: "signature",
                length: 4
            },
            {
                name: "numberOfDisks",
                length: 2
            },
            {
                name: "centralDirectoryStartDisk",
                length: 2
            },
            {
                name: "numberCentralDirectoryRecordsOnThisDisk",
                length: 2
            },
            {
                name: "numberCentralDirectoryRecords",
                length: 2
            },
            {
                name: "centralDirectorySize",
                length: 4
            },
            {
                name: "centralDirectoryOffset",
                length: 4
            },
            {
                name: "commentLength",
                length: 2
            },
            {
                name: "comment",
                length: "commentLength"
            }
        ];

        const endOfDirectory = this.readStruct(fields, offset);
        endOfDirectory[ZipReader.structTypeSymbol] = "endOfCentralDirectory";

        return endOfDirectory;
    }
    get entries() {
        return this.localFiles;
    }
}

ZipReader.totalLengthSymbol = Symbol("totalLength");
ZipReader.structTypeSymbol = Symbol("structType");
