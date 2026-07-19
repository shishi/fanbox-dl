// src/options/validate-templates.ts
// Options 画面のテンプレ/パス検証を DOM から切り離した純粋関数。
// save ボタンのガード(検証エラーがある間は保存拒否)がロジックとして
// テストできるよう、options.ts のプレビュー計算とここを共有する。
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import type { RenderContext } from "../core/types";

export interface TemplateCheckInput {
  tpl: string;
  ctx: RenderContext;
  replacement: string;
  segmentMaxLen: number;
  fullPathMaxLen: number;
  uniquifyHeadroom: number;
  conflictAction: "uniquify" | "overwrite";
}

export interface TemplateCheckResult {
  rel: string;   // 検証成功時のプレビュー用パス(失敗時は "")
  error: string; // 空文字ならエラーなし
}

export function checkTemplate(input: TemplateCheckInput): TemplateCheckResult {
  try {
    const rel = renderTemplate(input.tpl, input.ctx, {
      replacement: input.replacement, segmentMaxLen: input.segmentMaxLen,
    });
    const v = validatePath(rel, {
      fullPathMaxLen: input.fullPathMaxLen, uniquifyHeadroom: input.uniquifyHeadroom,
      conflictAction: input.conflictAction, segmentMaxLen: input.segmentMaxLen,
    });
    return { rel, error: v.ok ? "" : `検証エラー: ${v.error}` };
  } catch (e) {
    return { rel: "", error: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
}

export function hasTemplateError(inputs: TemplateCheckInput[]): boolean {
  return inputs.some((i) => checkTemplate(i).error !== "");
}

// save ガード用: メインテンプレのエラーは常にブロックするが、zip 系テンプレは
// zipEligible() が実際に参照する設定(zipGalleries チェック + contentTypes.photo)が
// 有効な場合に限りブロック対象にする(codex レビュー指摘 P2 round3)。
// zip モードを使っていないユーザーが、無関係な設定変更(zip モードの無効化を含む)を
// 保存できなくなる regression を防ぐ。
export function hasBlockingTemplateError(
  main: TemplateCheckInput,
  zip: { zipModeActive: boolean; zipPath: TemplateCheckInput; zipEntry: TemplateCheckInput },
): boolean {
  if (checkTemplate(main).error !== "") return true;
  if (!zip.zipModeActive) return false;
  return checkTemplate(zip.zipPath).error !== "" || checkTemplate(zip.zipEntry).error !== "";
}
