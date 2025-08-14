# calendarbot

To install dependencies:

```bash
bun install
```
There are some settings that can be exported as environment variables:
```
ICAL_PATH -- path to the fodler where all the generated Ical files should be stored;
OFFSET_SECONDS -- offset before the end date for the Ical events, since discord doesn't set an end time;
DISCORD_TOKEN -- bot token;
FILENAME - filename for the ics file.
```
To run:

```bash
bun run index.ts
```
or 
```bash
bun build index.ts --target=node --outdir=./release/
node release/index.js
```

This project was created using `bun init` in bun v1.0.25. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
