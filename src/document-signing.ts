import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import { ownerSender } from "./telegram-tools.js";
import { assertNativeAccess } from "./authorization.js";
import type { Store } from "./store.js";
import type { DynamicTool } from "./types.js";
import type { TelegramToolContext } from "./telegram-tools.js";
const execute = promisify(execFile);
/** Only the native signer and its document-bound Telegram approvals call this installed renderer. */
export function runDocumentSigning(directory: string, argv: string[]) {
    return execute("python3", ["-I", resolve(import.meta.dirname, "../scripts/document-signing.py"), directory, ...argv], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
}
const placement = z.strictObject({
    page: z.number().int().positive(), asset: z.enum(["signature", "signature_full", "stamp"]).optional(),
    type: z.enum(["text", "replace", "drop_annot"]).optional(),
    anchor: z.enum(["center", "topleft"]).optional(),
    x_mm: z.number().optional(), y_mm: z.number().optional(), width_mm: z.number().positive().optional(),
    rotate: z.number().min(-15).max(15).optional(), opacity: z.number().min(0.1).max(1).optional(),
    text: z.string().max(5000).optional(), find: z.string().min(1).max(5000).optional(), all: z.boolean().optional(),
    size_pt: z.number().min(5).max(72).optional(), color: z.array(z.number().min(0).max(1)).length(3).optional(),
    annot_type: z.string().max(80).optional(), contains: z.string().max(5000).optional(),
    rect_mm: z.array(z.number()).length(4).optional(), _why: z.string().max(2000).optional(), _zone: z.string().max(80).optional(),
});
const request = z.strictObject({
    action: z.enum(["inspect", "plan", "apply", "preview"]), path: z.string().min(1).max(4096),
    placements: z.array(placement).min(1).max(500).optional(), noStamp: z.boolean().optional(),
});

/** An explicit order in the sender's own words. Quoted examples and questions about signing stay conversations. */
export function requestsDocumentSigning(words?: string): boolean {
    if (!words) return false;
    const text = words.toLowerCase().replace(/^[ \t]*>.*$/gm, "").replace(/"[^"]*"|«[^»]*»|“[^”]*”|„[^“]*“|‘[^’]*’|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])|`[^`]*`/gu, " ").trim();
    const conditional = /\b(?:if|unless|once|until)\b/u.test(text)
        || /\b(?:when|after)\s+(?:[\p{L}’']+\s+){0,5}(?:approv\w*|confirm\w*|authori[sz]\w*|consent\w*|agree\w*|signs?\s+off)\b/u.test(text)
        || /(?:^|[^\p{L}])(?:если|когда|после\s+(?:(?:моего|твоего|вашего)\s+)?(?:согласования|подтверждения|одобрения))(?!\p{L})/u.test(text);
    const negation = /\b(?:don['’]t|not|never|shouldn['’]t|without)\s+(?:(?:need|want)\s+to\s+)?(?:sign|stamp)/u.test(text)
        || /(?:^|\s)не\s+(?:(?:надо|нужно|стоит|следует)\s+)?(?:подпис|подпиш|став|постав|простав)|(?:подписать|ставить\s+печать)\s+(?:его\s+|её\s+|это\s+)?не\s+(?:надо|нужно)/u.test(text);
    if (conditional || negation) return false;

    const action = (command: string, politeRequest: boolean) =>
        /^подпиши(?:те)?(?:\s|[,!.?]|$)/u.test(command)
        || /^(?:поставь(?:те)?|проставь(?:те)?|добавь(?:те)?|наложи(?:те)?)\s+(?:(?:мою|нашу|свою)\s+)?(?:подпись|печать)(?!\p{L})/u.test(command)
        || (politeRequest && /^(?:подписать(?:\s|[,?.!]|$)|(?:поставить|проставить|добавить|наложить)\s+(?:подпись|печать)(?!\p{L}))/u.test(command))
        || /^(?:sign|stamp)\s+(?:this|that|it|both|these|the|my|our|attached|here|and\s+(?:sign|stamp))\b/u.test(command)
        || /^(?:add|apply|affix|put)\s+(?:(?:my|our|the|a|company)\s+)+(?:signature|stamp|seal)\b/u.test(command);
    // A preparation step may name any document or contract. An embedded request
    // or another subject ("for Andrew to review and sign") breaks the chain.
    const preparation = (part: string) => {
        const english = /^(?:prepare|draft|write|create|fill|update|date|add)\s+/u.test(part);
        const russian = /^(?:составь(?:те)?|составить|подготовь(?:те)?|подготовить|заполни(?:те)?|заполнить|поставь(?:те)?|поставить|проставь(?:те)?|проставить|укажи(?:те)?|указать|датируй(?:те)?|датировать)\s+/u.test(part);
        if (!(english || russian) || /[:;!?]/u.test(part)) return false;
        if (english) return !/\b(?:to|who|whom|whose|where|whether|how|should|must|could|would|let|have|has|asks?|asking|asked|tells?|telling|told|says?|saying|said|instruct\w*|requesting|quot\w*|words)\b/u.test(part);
        return !/(?:^|\s)(?:что(?:бы)?|как|кто|кому|котор\p{L}*|пусть|надо|нужно|долж\p{L}*|просит|попрос\p{L}*|скаж\p{L}*|сказ\p{L}*|поруч\p{L}*|словами)(?!\p{L})/u.test(part);
    };
    const nextStep = /,\s*(?:(?:и\s+затем|and\s+then|и|затем|потом|and|then)\s+)?|\s+(?:и\s+затем|and\s+then|и|затем|потом|and|then)\s+/u;
    return text.split(/(?<=[.!?;])\s+|\n+/u).some(sentence => {
        const opening = sentence.trim().replace(/^(?:(?:wolf|волк|хорошо|окей|пожалуйста|okay|ok|please|now|теперь|а теперь)[,\s]+)+/u, "");
        const asking = /^(?:(?:can|could|would) you\s+(?:please\s+)?|(?:можешь|можете)[,\s]+(?:пожалуйста[,\s]+)?)/u;
        const politeRequest = asking.test(opening);
        if (opening.includes("?") && !politeRequest) return false;
        let command = opening.replace(asking, "");
        while (!action(command, politeRequest)) {
            const step = nextStep.exec(command);
            if (!step || !preparation(command.slice(0, step.index).trim())) return false;
            command = command.slice(step.index + step[0].length).trim();
        }
        return true;
    });
}
/** Assets and executable stay outside every agent workspace. Only this trusted
 * tool receives the adapter's sender; neither a skill nor a model supplies it. */
export function documentSigningTools(store: Store, context: TelegramToolContext) {
    const directory = context.files && resolve(context.files.root, ".data/sign-document");
    const allowed = () => {
        if (!directory || !context.scope || context.channel !== "telegram" || !ownerSender(store, context) || !requestsDocumentSigning(context.telegramDirectText))
            return false;
        try {
            assertNativeAccess(store, context.conversationId, context.telegramSenderId);
            const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
            if (!/^[1-9]\d{0,19}$/.test(config.telegramUserId) || context.telegramSenderId !== config.telegramUserId)
                return false;
            const conversation = store.getConversation(context.conversationId);
            const chat = store.telegramChats().find(c => c.conversationId === context.conversationId)
                ?? (conversation?.channel === "telegram" ? store.getTelegramChat(conversation.externalId?.split("::")[0] ?? "") : null);
            return Boolean(chat && chat.enabled !== false && existsSync(join(directory, "scripts/docsign.py")));
        }
        catch {
            return false;
        }
    };
    const assertAllowed = () => { if (!allowed()) throw new Error("Подпись и печать доступны только указанному владельцем Telegram-аккаунту по его текущему запросу."); };
    const definitions: DynamicTool[] = allowed() ? [{
            type: "function", name: "sign_document",
            description: "Sign or stamp a document ONLY on this sender's explicit current request. Server verifies the exact authorized Telegram account in DMs and groups on every call. inspect returns signature zones and the installed sign-document instructions; plan proposes placements in millimetres. Review and adjust placements before apply. apply creates a NEW signed PDF plus page previews: open those images before attach_file. Stamp is only for its legal entity, never another party. Signing does not authorize sending elsewhere. Use this tool, never shell access to signature assets. Supports PDF, DOCX, DOC, ODT and RTF.",
            inputSchema: z.toJSONSchema(request),
        }] : [];
    return { definitions, async call(input: unknown) {
            assertAllowed();
            const args = request.parse(input);
            const file = context.files!.readOutput(context.scope!, args.path);
            const extension = extname(file.name).toLowerCase();
            if (![".pdf", ".docx", ".doc", ".odt", ".rtf"].includes(extension))
                throw new Error("Выберите PDF, DOCX, DOC, ODT или RTF.");
            if (args.action === "apply" && !args.placements?.length)
                throw new Error("Сначала проверьте план размещения подписи.");
            const jobs = join(directory!, "jobs");
            mkdirSync(jobs, { recursive: true, mode: 0o700 });
            const job = mkdtempSync(join(jobs, "run-"));
            const source = join(job, "source" + extension), output = join(job, "signed.pdf"), planPath = join(job, "plan.json");
            writeFileSync(source, Buffer.from(file.contentBase64, "base64"), { mode: 0o600, flag: "wx" });
            const run = async (argv: string[]) => {
                assertAllowed();
                try {
                    return await runDocumentSigning(directory!, argv);
                }
                catch (error) {
                    throw new Error(String((error as { stderr?: unknown }).stderr || (error as { message?: unknown }).message).slice(0, 4000).replaceAll(job, "[document]"));
                }
            };
            try {
                if (args.action === "inspect") {
                    const reportPath = join(job, "report.json");
                    await run(["inspect", source, "--json", reportPath]);
                    return { report: { ...JSON.parse(readFileSync(reportPath, "utf8")), source: args.path }, instructions: readFileSync(join(directory!, "SKILL.md"), "utf8") };
                }
                if (args.action === "plan") {
                    const result = await run(["plan", source, "--out", planPath, "--output", output, ...(args.noStamp ? ["--no-stamp"] : [])]);
                    return { placements: JSON.parse(readFileSync(planPath, "utf8")).placements, notes: result.stderr.replaceAll(job, "[document]") };
                }
                let notes = "";
                if (args.action === "apply") {
                    writeFileSync(planPath, JSON.stringify({ source, output, placements: args.placements }), { mode: 0o600, flag: "wx" });
                    notes = (await run(["apply", "--plan", planPath, "--allow-overlap"])).stderr;
                }
                const preview = join(job, "preview");
                await run(["preview", args.action === "apply" ? output : source, "--out", preview, "--dpi", "150"]);
                assertAllowed();
                const destination = mkdtempSync(join(realpathSync(context.files!.workspace(context.scope!)), "signed-"));
                const previews = readdirSync(preview).filter(p => p.endsWith(".png")).sort().map(p => {
                    const target = join(destination, basename(p));
                    copyFileSync(join(preview, p), target);
                    return target;
                });
                const path = args.action === "apply" ? join(destination, basename(file.name, extname(file.name)) + "_signed.pdf") : undefined;
                if (path)
                    copyFileSync(output, path);
                return { path, previews, notes: notes.replaceAll(job, "[document]"), reviewRequired: true };
            }
            finally {
                rmSync(job, { recursive: true, force: true });
            }
        } };
}
