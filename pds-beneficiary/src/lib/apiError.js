// Turns an axios error into a status and a message the screen can show.
// status is null when no HTTP response came back (device cannot reach the
// server, or the request timed out). The message never includes tokens, request
// bodies or response bodies beyond the server's own short `error` string.
export function describeApiError(err) {
    if (!err?.response) {
        if (err?.code === "ECONNABORTED") {
            return { status: null, message: "The server took too long to respond." };
        }
        return {
            status: null,
            message: "Can't reach the server. Check that the backend is running and the app's API address is correct.",
        };
    }

    const status = err.response.status;
    if (status === 401) return { status, message: "Your session has expired. Please log in again." };
    if (status === 404) return { status, message: "This information is not available for your account." };
    if (status >= 500) return { status, message: "The server ran into a problem. Please try again." };

    const serverMessage = typeof err.response.data?.error === "string" ? err.response.data.error : null;
    return { status, message: serverMessage || `Request failed (${status}).` };
}
