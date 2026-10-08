import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { HomeError } from "./home.js";
import { previewExtension, type ExtensionFile } from "./extensions.js";

/** Files only: a package never follows a symlink outside the selected folder. */
export async function readExtensionBundle(input: string): Promise<ExtensionFile[]> {
  const root = resolve(input), files: ExtensionFile[] = []; let bytes = 0, entries = 0;
  const visit = async (path: string, name: string) => {
    const info = await lstat(path);
    if (++entries>1000 || name.length>240) throw new HomeError("Слишком много файлов или вложенных папок.");
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new HomeError("В пакете есть ссылка или специальный файл. Выберите папку с обычными файлами.");
    if (info.isDirectory()) {
      for(const entry of await readdir(path)) { if(entry === ".git" || entry === ".DS_Store") continue; await visit(join(path,entry),name ? name+"/"+entry : entry); }
    } else {
      bytes += info.size;
      if(bytes>10*1024*1024 || files.length>=300) throw new HomeError("Пакет должен содержать не более 300 файлов и занимать до 10 МБ.");
      files.push({path:name,contentBase64:(await readFile(path)).toString("base64"),executable:Boolean(info.mode & 0o100)});
    }
  };
  await visit(root,(await lstat(root)).isDirectory() ? "" : basename(root));
  previewExtension(files);
  return files;
}
