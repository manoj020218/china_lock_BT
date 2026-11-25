import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { installTouchFeedback } from "./feedback";
import "./styles.css";

installTouchFeedback();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
