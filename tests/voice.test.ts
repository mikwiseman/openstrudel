import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { readFile, rm, stat, writeFile } from "node:fs/promises";

function pcmWav(silent = false): Buffer {
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(2, 40); wav.writeInt16LE(silent ? 0 : 1000, 44);
  return wav;
}

const mocks = vi.hoisted(() => ({ run: vi.fn(), access: vi.fn(), platform: vi.fn(), directories: [] as string[] }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.run }) }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), platform: mocks.platform }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, access: mocks.access, mkdtemp: async (prefix: string) => {
    const directory = await actual.mkdtemp(prefix); mocks.directories.push(directory); return directory;
  } };
});
import { transcribeVoice } from "../src/voice.js";

beforeEach(() => {
  mocks.platform.mockReturnValue("linux"); mocks.access.mockResolvedValue(undefined); mocks.run.mockReset();
  mocks.run.mockImplementation(async (binary: string, args: string[]) => {
    if (binary.endsWith("ffprobe")) return { stdout: JSON.stringify({ format: { duration: "3.25" } }) };
    if (binary.endsWith("ffmpeg")) await writeFile(args.at(-1)!, pcmWav());
    if (binary.endsWith("whisper-cli")) await writeFile(args[args.indexOf("-of") + 1] + ".txt", "Привет, мир.\n");
    return { stdout: "" };
  });
});
afterEach(async () => {
  for (const directory of mocks.directories.splice(0)) {
    try { await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  vi.clearAllMocks();
});

describe("offline voice", () => {
  it("rejects empty and oversized audio before starting a process", async () => {
    await expect(transcribeVoice(new Uint8Array())).rejects.toThrow("пустое");
    await expect(transcribeVoice(new Uint8Array(20_000_001))).rejects.toThrow("20 МБ");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("explains a missing Linux speech installation without exposing paths", async () => {
    mocks.access.mockRejectedValue(new Error("ENOENT /private/path"));
    await expect(transcribeVoice(new Uint8Array([1]))).rejects.toThrow("обновите OpenStrudel");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects unknown or long duration before decoding and cleans up", async () => {
    for (const duration of ["N/A", "NaN", "0", "-1", "301"]) {
      mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify({ format: { duration } }) });
      await expect(transcribeVoice(new Uint8Array([1]))).rejects.toThrow(duration === "301" ? "5 минут" : "прочитать");
    }
    expect(mocks.run.mock.calls.every(([binary]) => binary.endsWith("ffprobe"))).toBe(true);
  });

  it("hides decoder internals and removes uploaded audio on failure", async () => {
    mocks.run.mockRejectedValueOnce(new Error("ffprobe: private contents and paths"));
    await expect(transcribeVoice(new Uint8Array([1]))).rejects.toThrow("Не удалось прочитать голосовое");
  });

  it("rejects decoded audio that exceeds the duration declared by its container", async () => {
    mocks.run.mockImplementation(async (binary: string, args: string[]) => {
      if (binary.endsWith("ffprobe")) return { stdout: '{"format":{"duration":"3"}}' };
      if (binary.endsWith("ffmpeg")) await writeFile(args.at(-1)!, new Uint8Array(301 * 32_000));
      return { stdout: "" };
    });
    await expect(transcribeVoice(new Uint8Array([1]))).rejects.toThrow("5 минут");
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("rejects a digitally silent recording instead of accepting a hallucinated word", async () => {
    mocks.run.mockImplementation(async (binary: string, args: string[]) => {
      if (binary.endsWith("ffprobe")) return { stdout: '{"format":{"duration":"3"}}' };
      if (binary.endsWith("ffmpeg")) await writeFile(args.at(-1)!, pcmWav(true));
      if (binary.endsWith("whisper-cli")) await writeFile(args[args.indexOf("-of") + 1] + ".txt", "you");
      return { stdout: "" };
    });
    await expect(transcribeVoice(new Uint8Array([1]))).rejects.toThrow("Речь не распознана");
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("reports a recognition timeout clearly and removes temporary files", async () => {
    mocks.run.mockImplementation(async (binary: string, args: string[]) => {
      if (binary.endsWith("ffprobe")) return { stdout: '{"format":{"duration":"3"}}' };
      if (binary.endsWith("ffmpeg")) await writeFile(args.at(-1)!, pcmWav());
      if (binary.endsWith("whisper-cli")) throw Object.assign(new Error("private stderr"), { killed: true });
      return { stdout: "" };
    });
    await expect(transcribeVoice(new Uint8Array([1]))).rejects.toThrow("слишком много времени");
  });

  it("rejects an empty transcript", async () => {
    mocks.run.mockImplementation(async (binary: string, args: string[]) => {
      if (binary.endsWith("ffprobe")) return { stdout: '{"format":{"duration":"3"}}' };
      if (binary.endsWith("ffmpeg")) await writeFile(args.at(-1)!, pcmWav());
      if (binary.endsWith("whisper-cli")) await writeFile(args[args.indexOf("-of") + 1] + ".txt", " \n");
      return { stdout: "" };
    });
    await expect(transcribeVoice(new Uint8Array([1]))).rejects.toThrow("Речь не распознана");
  });

  it("runs bounded offline decoding and multilingual recognition without a shell", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.run.mockImplementation(async (binary: string, args: string[], options: Record<string, unknown>) => {
      expect(options.shell).not.toBe(true);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.maxBuffer).toBeLessThanOrEqual(1_048_576);
      if (binary.endsWith("ffprobe")) {
        const path = args.at(-1)!;
        expect(await readFile(path)).toEqual(Buffer.from(bytes));
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(args).toContain("-protocol_whitelist");
        expect(args).toContain("-format_whitelist");
        return { stdout: '{"format":{"duration":"3.25"}}' };
      }
      if (binary.endsWith("ffmpeg")) {
        expect(args).toContain("-nostdin"); expect(args).toContain("16000"); expect(args).toContain("-t");
        await writeFile(args.at(-1)!, pcmWav());
      }
      if (binary.endsWith("whisper-cli")) {
        expect(args).toEqual(expect.arrayContaining(["-l", "auto", "-t", "2", "-ng", "-fa"]));
        expect(options.env).toMatchObject({ OPENBLAS_NUM_THREADS: "2", OMP_NUM_THREADS: "2" });
        const prefix = args[args.indexOf("-of") + 1];
        expect(dirname(prefix)).toBe(mocks.directories.at(-1));
        await writeFile(prefix + ".txt", "Привет, мир.\n");
      }
      return { stdout: "" };
    });
    expect(await transcribeVoice(bytes, "ogg;$(touch bad)")).toBe("Привет, мир.");
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });

  it("keeps one recognition in memory and releases the slot after failure", async () => {
    let reject!: (error: Error) => void;
    mocks.run.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = transcribeVoice(new Uint8Array([1]));
    const firstResult = first.catch(error => error);
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    try { await expect(transcribeVoice(new Uint8Array([2]))).rejects.toThrow("Уже распознаю"); }
    finally { reject(new Error("broken audio")); }
    expect(await firstResult).toMatchObject({ message: expect.stringContaining("прочитать") });
    expect(await transcribeVoice(new Uint8Array([3]))).toBe("Привет, мир.");
  });

  it("preserves the installed Mac OpenRamble path", async () => {
    mocks.platform.mockReturnValue("darwin"); mocks.run.mockResolvedValue({ stdout: "  Проверка OpenRamble.\n" });
    expect(await transcribeVoice(new Uint8Array([1]))).toBe("Проверка OpenRamble.");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][0]).toContain("openramble");
    expect(mocks.run.mock.calls[0][1]).toEqual([join(mocks.directories[0], "voice.ogg"), "--format", "txt"]);
  });
});
