async function render() {
  const box = document.getElementById("box");
  const res = await chrome.storage.local.get("fcLastShipDiag");
  const d = res.fcLastShipDiag;
  if (!d) {
    box.textContent = "（まだ診断データがありません。出品ページで入力を実行してください）";
    return;
  }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = d.ok ? "ok" : "fail";
  head.textContent =
    (d.ok ? "成功" : "失敗") + " / 候補: " + (d.method || "") + " / " +
    new Date(d.at).toLocaleString("ja-JP");
  const body = document.createElement("div");
  body.textContent = d.diag;
  box.appendChild(head);
  box.appendChild(body);
}
render();
setInterval(render, 2000);
