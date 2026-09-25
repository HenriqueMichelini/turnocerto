const apiBaseUrl = process.env.VITE_API_BASE_URL;
if (!apiBaseUrl) {
  throw new Error("Set VITE_API_BASE_URL to the deployed Go API Worker origin before deploying Pages.");
}

let apiUrl;
try {
  apiUrl = new URL(apiBaseUrl);
} catch {
  throw new Error("VITE_API_BASE_URL must be a valid absolute URL.");
}

if (apiUrl.protocol !== "https:" || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
  throw new Error("VITE_API_BASE_URL must be an HTTPS origin without a path, query, or fragment.");
}
