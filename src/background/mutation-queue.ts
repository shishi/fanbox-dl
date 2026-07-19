// spec §7c-2: ledger への read-modify-write を直列化する single-writer キュー。
// キュー項目は短命な storage 操作のみを含めること(download() 等の待機を入れると
// 解消側の更新が同じキューの後ろに詰まりデッドロックする)。その規律は呼び出し側
// (job-store / service-worker)の契約であり、このクラスは純粋な直列化だけを提供する。
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn); // 前段の失敗でチェーンを止めない
    this.tail = next.catch(() => {});
    return next;
  }
}
