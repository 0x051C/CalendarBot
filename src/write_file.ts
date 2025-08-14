import fs from "node:fs";
import path from "path";
import { ICAL_PATH, FILENAME } from "./env_config";
import { type Path } from "typescript";

const writeFile = (filePath: Path | string, folder: string, data: string, callback: any) => {
  fs.mkdir(path.join(ICAL_PATH, folder), { recursive: true }, (err) => {
    if (err) {
      return callback(err);
    }
    fs.writeFile(filePath, data, (err) => {
      if (err) {
        return callback(err);
      }
      callback(`Wrote ${FILENAME} to disk.\nfile://${path.join(ICAL_PATH, folder)}`);
    });
  });
};
export async function write_calendar_file(data: string, folder: Path | string) {
  writeFile(path.join(ICAL_PATH, folder, FILENAME), folder, data, (err: any) => { console.log(err) });
}

