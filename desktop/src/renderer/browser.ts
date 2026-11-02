// The toolbar above a page in Kiki's browser window: where Kiki is, Keep, Stop and Hide.
import "@fontsource-variable/geist";
import "./browser.css";

const api = window.kiki.browser;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const label = $<HTMLSpanElement>("label");
const url = $<HTMLSpanElement>("url");
const keep = $<HTMLButtonElement>("keep");

api.onState((state) => {
  const shown = state.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  url.textContent = shown;
  url.title = state.url;
  label.textContent = state.takenOver ? "You're in control" : state.title ? state.title : "Kiki's browser";
  keep.textContent = state.kept ? "Kept" : "Keep";
  keep.classList.toggle("on", state.kept);
  document.body.classList.toggle("taken-over", state.takenOver);
});

keep.addEventListener("click", () => api.keep());
$("stop").addEventListener("click", () => api.stop());
$("hide").addEventListener("click", () => api.hide());
