// spec §13-6 walking skeleton v2: content script(isolated world)からの
// post.info fetch が cookie 込みで 200 になるかの hard gate。
// gate v1(SW fetch)は Origin: chrome-extension:// で 400 だった。
// isolated world fetch はページオリジン(https://www.fanbox.cc)を Origin として送る。
// fanbox.cc の任意ページで自動実行し、ページの console に結果を出す。
(async () => {
  try {
    const r = await fetch("https://api.fanbox.cc/post.info?postId=12272980", {
      credentials: "include",
    });
    const j = await r.json().catch(() => null);
    console.log(
      "[fanbox-dl gate v2] origin =", location.origin,
      "status =", r.status,
      "post.id =", j?.body?.post?.id,
      "type =", j?.body?.post?.type
    );
  } catch (e) {
    console.error("[fanbox-dl gate v2] FAILED:", e);
  }
})();
