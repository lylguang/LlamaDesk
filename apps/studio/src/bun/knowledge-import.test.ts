import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { addFileDocs, addFolderDocs, createKb } from "./knowledge";
import { kbFileSupported, KB_SUPPORTED_EXT } from "../shared/knowledge";

/**
 * 知识库导入的白名单判定（issue #28）。
 *
 * 背景：文件选择器不再用原生扩展名过滤器挡不支持的类型（Windows 上 Electrobun 把逗号分隔的
 * 每个扩展名渲染成一条独立过滤器、首条即默认，反而会把 .md / .pdf 等藏起来），所以
 * 「支持哪些文件」必须由主进程按 shared/knowledge.ts 的白名单兜底，并且**计数回报**，
 * 否则用户选了不支持的文件只会得到一句没有信息量的失败。
 */

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kb-import-"));
}

test("kbFileSupported：白名单内、大小写不敏感、无扩展名/白名单外一律不支持", () => {
  expect(kbFileSupported("笔记.md")).toBe(true);
  expect(kbFileSupported("README.MD")).toBe(true);
  expect(kbFileSupported("数据.csv")).toBe(true);
  expect(kbFileSupported("报表.pdf")).toBe(true);
  expect(kbFileSupported("录音.M4A")).toBe(true);
  // 白名单外（用户下载目录里常见的那几个）
  expect(kbFileSupported("跨境资金集中运营管理规定（1）.docx")).toBe(false);
  expect(kbFileSupported("2026年结售汇数据（1）.xlsx")).toBe(false);
  expect(kbFileSupported("安装包.exe")).toBe(false);
  expect(kbFileSupported(".jpg")).toBe(false); // 隐藏文件恰好以扩展名结尾，没有主名
  expect(kbFileSupported("无扩展名")).toBe(false);
  // .markdown 与 .md 都在名单里（此前二者生成两条几乎同名的过滤器）
  expect(KB_SUPPORTED_EXT as readonly string[]).toContain("md");
  expect(KB_SUPPORTED_EXT as readonly string[]).toContain("markdown");
});

test("addFileDocs：跳过不支持的扩展名与不存在的路径，并把跳过数回报出来", () => {
  const kb = createKb({ name: "导入白名单" });
  const dir = tmpDir();
  const md = path.join(dir, "合规笔记.md");
  const docx = path.join(dir, "规定.docx");
  writeFileSync(md, "# 标题\n正文");
  writeFileSync(docx, "binary-ish");

  const res = addFileDocs(kb.id, [md, docx, path.join(dir, "不存在.md")]);

  expect(res.docs.map((d) => d.name)).toEqual(["合规笔记.md"]);
  // .docx 不支持 + 路径不存在，各算一个跳过
  expect(res.skipped).toBe(2);
});

test("addFolderDocs：目录里白名单外/超限的文件计入 skipped，白名单内的照常入库", () => {
  const kb = createKb({ name: "目录白名单" });
  const dir = tmpDir();
  mkdirSync(path.join(dir, "子目录"));
  writeFileSync(path.join(dir, "上层.MD"), "markdown");
  writeFileSync(path.join(dir, "子目录", "下层.txt"), "text");
  writeFileSync(path.join(dir, "表格.xlsx"), "unsupported");
  writeFileSync(path.join(dir, "说明.docx"), "unsupported");

  const res = addFolderDocs(kb.id, dir);

  expect(res.docs.map((d) => d.name).sort()).toEqual(["上层.MD", "下层.txt"]);
  expect(res.skipped).toBe(2);
});
