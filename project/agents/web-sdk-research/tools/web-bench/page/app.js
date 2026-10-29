// The test app: same code for every cell. An SPA-ish page with about 2,000 DOM nodes (or
// window.__BENCH__.nodes), a list that re-renders every second, pushState routes, one fetch per
// click to the intake host, and a button that throws.
const bench = window.__BENCH__ || {};
const api = `${bench.intake}/api`;
const routes = ["home", "products", "cart", "account", "help"];
const nav = document.getElementById("nav");
const view = document.getElementById("view");
const list = document.getElementById("list");
const rows = bench.nodes ? Math.round((bench.nodes - 400) / 8) : 200; // 8 nodes per row
let tick = 0;

for (const r of routes) {
  const a = document.createElement("a");
  a.href = `${r}`;
  a.id = `nav-${r}`;
  a.textContent = r;
  a.addEventListener("click", (e) => { e.preventDefault(); go(r); });
  nav.append(a);
}

function rowHtml(i, t) {
  return `<span class="id">#${i}</span><span class="name">Item ${i}</span><span class="price">${((i * 7 + t) % 100).toFixed(2)}</span><span class="qty">${(i + t) % 9}</span><button type="button" data-i="${i}">Add</button>`;
}

function renderList() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < rows; i++) {
    const li = document.createElement("li");
    li.className = "row";
    li.innerHTML = rowHtml(i, 0);
    frag.append(li);
  }
  list.replaceChildren(frag);
}

// Every second: 30 rows get new text, 5 rows move, one row is highlighted.
function mutate() {
  tick++;
  const items = list.children;
  for (let k = 0; k < 30; k++) {
    const i = (tick * 31 + k * 7) % items.length;
    items[i].innerHTML = rowHtml(i, tick);
  }
  for (let k = 0; k < 5; k++) list.append(items[(tick * 13 + k) % items.length]);
  list.querySelector(".hot")?.classList.remove("hot");
  items[tick % items.length].classList.add("hot");
}

function renderView(route, data) {
  const cards = Array.from({ length: 40 }, (_, i) => `<div class="card"><h3>${route} ${i}</h3><p>${data ? data.id : "…"} text ${i}</p></div>`).join("");
  view.innerHTML = `<h2>${route}</h2><section>${cards}</section>`;
}

async function fetchItem(tag) {
  const r = await fetch(`${api}/item?${tag}-${Date.now()}`);
  return r.json();
}

async function go(route) {
  history.pushState({ route }, "", `${route}`);
  renderView(route);
  renderView(route, await fetchItem(route));
}

window.addEventListener("popstate", (e) => renderView(e.state?.route ?? "home"));
document.getElementById("load").addEventListener("click", async () => {
  const d = await fetchItem("load");
  view.querySelector("h2").textContent = `loaded ${d.items.length}`;
});
document.getElementById("boom").addEventListener("click", () => {
  fetchItem("boom");
  throw new Error("bench: thrown from a click handler");
});
list.addEventListener("click", (e) => { if (e.target.dataset.i) e.target.textContent = "Added"; });

renderList();
renderView("home");
setInterval(mutate, 1000);
performance.mark("app-ready");
