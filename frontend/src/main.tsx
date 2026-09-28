import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.VITE_CAPACITY_BENCHMARK === "true") {
  void import("./launch-capacity-benchmark").then(({ startLaunchCapacityBenchmark }) => {
    startLaunchCapacityBenchmark();
  });
}
