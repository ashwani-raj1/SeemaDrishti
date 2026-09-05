/**
 * Entry point. Mounts the operator screen; everything else is decided by the
 * deployment's client.json and the feature registry.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./boot";
import "./index.css";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  createRoot(elem).render(app);
}
