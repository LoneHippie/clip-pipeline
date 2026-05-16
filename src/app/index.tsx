import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";

const elem = document.getElementById("root")!;
const root = (import.meta as { hot?: { data: Record<string, unknown> } }).hot
  ?.data;
if (root) {
  root.root ??= createRoot(elem) as ReturnType<typeof createRoot>;
  (root.root as ReturnType<typeof createRoot>).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  createRoot(elem).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
