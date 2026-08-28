import { describe, it, expect } from "vitest";
import { createFilenameGuard } from "../src/background/filename-guard";

function mkSuggest() {
  const calls: Array<{ filename: string; conflictAction: string }> = [];
  return { calls, suggest: (o: any) => { calls.push(o); } };
}

function mkDeterminingFilenameEvent() {
  type Listener = (
    item: { url?: string },
    suggest: (o: { filename: string; conflictAction: string }) => void,
  ) => void;
  const listeners = new Set<Listener>();
  return {
    event: {
      addListener: (listener: Listener) => { listeners.add(listener); },
      removeListener: (listener: Listener) => { listeners.delete(listener); },
    },
    listenerCount: () => listeners.size,
    dispatch(item: { url?: string }) {
      const suggestions: Array<{ filename: string; conflictAction: string }> = [];
      for (const listener of [...listeners]) {
        listener(item, (suggestion) => { suggestions.push(suggestion); });
      }
      return suggestions;
    },
  };
}

const U = "https://downloads.fanbox.cc/images/post/1/a.jpeg";

describe("filename guard (downloads.onDeterminingFilename の横取り対策)", () => {
  it("自分が発行した DL には、claim したテンプレ名を uniquify で suggest する", async () => {
    const g = createFilenameGuard();
    await g.claimAndDownload(U, "20260115 T  a.jpeg", async () => 1);
    const { calls, suggest } = mkSuggest();
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(true);
    expect(calls).toEqual([{ filename: "20260115 T  a.jpeg", conflictAction: "uniquify" }]);
  });

  it("claim していない DL(他拡張・ユーザー操作由来)には suggest を一切呼ばない", () => {
    const g = createFilenameGuard();
    const { calls, suggest } = mkSuggest();
    expect(g.handleDeterminingFilename({ url: "https://example.com/other.pdf" }, suggest)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("同一 URL の DL が重なっても両方に suggest する(FIFO)。使い切ったら他拡張の DL 扱いに戻る", async () => {
    const g = createFilenameGuard();
    await g.claimAndDownload(U, "one.jpeg", async () => 1);
    await g.claimAndDownload(U, "two.jpeg", async () => 2);
    const { calls, suggest } = mkSuggest();
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(true);
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(true);
    expect(calls.map((c) => c.filename)).toEqual(["one.jpeg", "two.jpeg"]);
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(false);
  });

  it("claimAndDownload: download が throw したら、その 1 件だけ claim を取り消す", async () => {
    const g = createFilenameGuard();
    await g.claimAndDownload(U, "kept.jpeg", async () => 1);
    await expect(
      g.claimAndDownload(U, "dropped.jpeg", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    const { calls, suggest } = mkSuggest();
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(true);
    expect(calls.map((c) => c.filename)).toEqual(["kept.jpeg"]);
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(false);
  });

  it("claimAndDownload: 同一 URL の DL が並行していると、失敗した側は自分の claim だけを落とす", async () => {
    // claim() と download() の間で制御が移るため、先発が await している間に
    // 後発が同じ URL を claim できる。取り消しが「キューの最後」を落とす実装だと
    // 先発の失敗が後発の claim を巻き込み、後発だけ生ファイル名で保存される。
    const g = createFilenameGuard();
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const first = g.claimAndDownload(U, "first.jpeg", async () => {
      await gate;
      throw new Error("boom");
    });
    const second = await g.claimAndDownload(U, "second.jpeg", async () => 2);
    expect(second).toBe(2);
    openGate();
    await expect(first).rejects.toThrow("boom");

    const { calls, suggest } = mkSuggest();
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(true);
    expect(calls.map((c) => c.filename)).toEqual(["second.jpeg"]);
    expect(g.handleDeterminingFilename({ url: U }, suggest)).toBe(false);
  });

  it("Chrome 側の URL 正規化(非 ASCII のパーセントエンコード)を跨いで claim を引き当てる", async () => {
    const g = createFilenameGuard();
    const raw = "https://downloads.fanbox.cc/files/post/1/日本語.zip";
    const normalized = new URL(raw).href;
    expect(normalized).not.toBe(raw); // 前提: 表記がズレ得ること自体を確かめる
    await g.claimAndDownload(raw, "20260115 T  日本語.zip", async () => 1);
    const { calls, suggest } = mkSuggest();
    expect(g.handleDeterminingFilename({ url: normalized }, suggest)).toBe(true);
    expect(calls[0].filename).toBe("20260115 T  日本語.zip");
  });

  it("姉妹拡張との競合回避: claim がある guard だけ listener を登録し、消費後は解除する", async () => {
    const event = mkDeterminingFilenameEvent();
    const owner = createFilenameGuard();
    const sibling = createFilenameGuard();
    owner.bindDeterminingFilenameEvent(event.event);
    sibling.bindDeterminingFilenameEvent(event.event);

    expect(event.listenerCount()).toBe(0);
    await owner.claimAndDownload(U, "owner.jpeg", async () => 1);
    expect(event.listenerCount()).toBe(1);

    expect(event.dispatch({ url: U })).toEqual([
      { filename: "owner.jpeg", conflictAction: "uniquify" },
    ]);
    expect(event.listenerCount()).toBe(0);
  });
});
