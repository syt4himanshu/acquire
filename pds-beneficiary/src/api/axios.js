import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import Constants from "expo-constants";

const normalizeUrl = (url) => {
  let u = url?.trim().replace(/\/+$/, "");
  // Common typo breaks axios / fetch (no response → generic app errors).
  if (u && /^hhttp:\/\//i.test(u)) u = u.replace(/^hhttp/i, "http");
  return u || "";
};

const getExpoHost = () => {
  const hostUri =
    Constants.expoConfig?.hostUri ||
    Constants.manifest2?.extra?.expoClient?.hostUri ||
    Constants.manifest?.debuggerHost;

  if (!hostUri) return null;
  return hostUri.split(":")[0];
};

// Must match pds-backend `PORT` (default 5000 in server.js / .env.example).
const DEFAULT_API_PORT = "5000";

const resolveBaseURL = () => {
  const envBaseUrl = normalizeUrl(process.env.EXPO_PUBLIC_API_BASE_URL);
  if (envBaseUrl) return envBaseUrl;

  const expoHost = getExpoHost();
  if (expoHost) return `http://${expoHost}:${DEFAULT_API_PORT}`;

  if (Platform.OS === "android") return `http://10.0.2.2:${DEFAULT_API_PORT}`;
  return `http://localhost:${DEFAULT_API_PORT}`;
};

const baseURL = resolveBaseURL();

const api = axios.create({
  baseURL,
  timeout: 10000,
});

// Attach token to every request
api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 globally — clear token so AuthContext can react
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (__DEV__) {
      // Method, path, status and error code only. Headers, request bodies and
      // response bodies are never logged, so tokens and OTPs stay out of the console.
      const method = error.config?.method?.toUpperCase() ?? "?";
      const path = error.config?.url ?? "(unknown path)";
      const status = error.response?.status ?? "no response";
      console.warn(`[api] ${method} ${path} -> ${status}${error.code ? ` (${error.code})` : ""}`);
    }
    if (error.response?.status === 401) {
      await AsyncStorage.removeItem("token");
    }
    return Promise.reject(error);
  },
);

if (__DEV__) {
  console.log(`[api] base URL: ${baseURL}`);
}

export const resolvedApiBaseUrl = baseURL;

export default api;
