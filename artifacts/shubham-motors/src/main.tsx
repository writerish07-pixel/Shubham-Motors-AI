import { createRoot } from "react-dom/client";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Attach the admin token (saved by the Settings page) to every generated API
// request so the token-gated /api/* routes accept the CRM dashboard's calls.
setAuthTokenGetter(() => localStorage.getItem("shubham_admin_token"));

createRoot(document.getElementById("root")!).render(<App />);
