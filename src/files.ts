import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep, extname } from "node:path";
import type { Store } from "./store.js";
import type { Attachment } from "./types.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
type StoredFile = Attachment & { path: string };
export class ConversationFiles {
  constructor(private readonly store: Store, private readonly root = process.cwd()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS conversation_files(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL)`);
  }
  workspace(context: string): string { return resolve(this.root,".data/workspace",context); }
  put(conversationId: string, context: string, input: { id?: string; name: string; mimeType?: string; contentBase64: string }): Attachment {
    if (!this.store.getConversation(conversationId)) throw new Error("Чат не найден");
    const id = input.id ?? randomUUID();
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Некорректный файл");
    const name = basename(input.name.replaceAll("\\","/")).replace(/[\x00-\x1f]/g,"").trim();
    if (!name || name.length > 180 || name === "." || name === "..") throw new Error("Проверьте имя файла");
    const bytes = Buffer.from(input.contentBase64,"base64");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Выберите файл до 25 МБ");
    const previous = this.get(id);
    if (previous) {
      if (previous.conversationId !== conversationId || previous.name !== name || !readFileSync(previous.path).equals(bytes)) throw new Error("Этот файл уже принадлежит другому сообщению");
      return this.public(previous);
    }
    const directory = resolve(this.workspace(context),"files",conversationId);
    mkdirSync(directory,{recursive:true,mode:0o700});
    const path = resolve(directory,id + "-" + name);
    writeFileSync(path,bytes,{mode:0o600,flag:"wx"});
    const mimeType = input.mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ? input.mimeType : "application/octet-stream";
    this.store.db.prepare("INSERT INTO conversation_files VALUES(?,?,?,?,?,?)").run(id,conversationId,name,mimeType,bytes.length,path);
    return {id,conversationId,name,mimeType,size:bytes.length};
  }
  output(conversationId:string,context:string,path:string): Attachment {
    const workspace=realpathSync(this.workspace(context));
    const candidate=resolve(workspace,path);
    const actual=realpathSync(candidate);
    if (!actual.startsWith(workspace+sep) || !statSync(actual).isFile()) throw new Error("Файл должен находиться в рабочей области сотрудника");
    if (statSync(actual).size > MAX_FILE_BYTES) throw new Error("Выберите файл до 25 МБ");
    const mimeTypes:Record<string,string>={".pdf":"application/pdf",".txt":"text/plain",".md":"text/markdown",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".csv":"text/csv",".json":"application/json",".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation",".mp3":"audio/mpeg",".m4a":"audio/mp4"};
    return this.put(conversationId,context,{name:basename(actual),mimeType:mimeTypes[extname(actual).toLowerCase()],contentBase64:readFileSync(actual).toString("base64")});
  }
  get(id: string): StoredFile | null {
    const r = this.store.db.prepare("SELECT * FROM conversation_files WHERE id=?").get(id) as Record<string, any> | undefined;
    return r ? {id:r.id,conversationId:r.conversation_id,name:r.name,mimeType:r.mime_type,size:r.size,path:r.path} : null;
  }
  forMessage(conversationId: string, ids: string[] = []): StoredFile[] {
    if (!Array.isArray(ids) || ids.length > 6 || ids.some(id=>typeof id !== "string")) throw new Error("Можно прикрепить до шести файлов");
    return [...new Set(ids)].map(id=>{const file=this.get(id);if(!file || file.conversationId !== conversationId) throw new Error("Файл недоступен этому чату");return file;});
  }
  public(file: StoredFile): Attachment { const {path: _,...metadata}=file; return metadata; }
}
