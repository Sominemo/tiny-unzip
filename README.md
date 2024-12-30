# Tiny unzip

A small unzip library that uses browser DecompressionStream API.

This is a sister project to [tiny-xlsx-reader](https://github.com/Sominemo/tiny-xlsx-reader), 
this library was designed to be used with it, but it can be used independently.

In particular, this library can handle ZIP files that only contain the real central 
directory at the end of the file, which is the kind of ZIP files that the
Microsoft Office suite generates.

## Usage example

```javascript
import { ZipReader } from "./tiny-unzip";

const zip = new ZipReader(await filePicker.files[0].arrayBuffer())
await zip.read();
const sharedStrings = await zip.extractByFileName("xl/sharedStrings.xml");
const fileBuffer = await sharedStrings.arrayBuffer();
const sharedStringsXml = new TextDecoder().decode(fileBuffer);
```

## List of files and directories in the ZIP

Unique file names are not guaranteed

```javascript
import { ZipReader } from "./tiny-unzip";

const zip = new ZipReader(await filePicker.files[0].arrayBuffer())
const files = zip.entries;

for (const file of files) {
    console.log(file.fileName);
}
```
