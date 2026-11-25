package fr.scanr.typerstudio;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "TypeRLocalAI")
public class TypeRLocalAIPlugin extends Plugin {
    private static final int MAX_JSON_SIZE = 24 * 1024 * 1024;
    private final ExecutorService requests = Executors.newFixedThreadPool(2);

    private static int portFor(String model) {
        switch (model) {
            case "mat-512": return 7870;
            case "flux2-klein-4b": return 7868;
            case "flux3-klein": return 7869;
            default: return 0;
        }
    }

    @PluginMethod
    public void request(PluginCall call) {
        int port = portFor(call.getString("model", ""));
        String action = call.getString("action", "");
        String id = call.getString("id", "");
        if (port == 0 || (("poll".equals(action) || "cancel".equals(action)) && !id.matches("[A-Za-z0-9_-]{1,128}"))) {
            call.reject("Invalid local inference request.");
            return;
        }

        String route;
        JSObject body = null;
        switch (action) {
            case "check":
                route = "/capabilities";
                break;
            case "submit":
                route = "/img_gen";
                body = call.getObject("body");
                if (body == null) {
                    call.reject("The local inference request has no image.");
                    return;
                }
                break;
            case "poll":
                route = "/jobs/" + id;
                break;
            case "cancel":
                route = "/jobs/" + id + "/cancel";
                body = new JSObject();
                break;
            default:
                call.reject("Unknown local inference action.");
                return;
        }

        final JSObject payload = body;
        requests.execute(() -> {
            try {
                call.resolve(send(port, route, payload));
            } catch (Exception error) {
                call.reject("Local inference runtime on port " + port + ": " + error.getMessage());
            }
        });
    }

    private JSObject send(int port, String route, JSObject body) throws Exception {
        URL url = URI.create("http://127.0.0.1:" + port + "/sdcpp/v1" + route).toURL();
        HttpURLConnection connection = (HttpURLConnection) url.openConnection(Proxy.NO_PROXY);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(2_000);
        connection.setReadTimeout(15_000);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_JSON_SIZE) throw new IOException("Select a smaller region.");
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }

            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                try (InputStream input = connection.getInputStream()) {
                    return new JSObject(readJson(input, MAX_JSON_SIZE));
                }
            }
            String message = "HTTP " + status;
            try (InputStream input = connection.getErrorStream()) {
                if (input != null) {
                    JSObject failure = new JSObject(readJson(input, 4096));
                    JSObject value = failure.getJSObject("error");
                    if (value != null) message = value.getString("message", message);
                }
            } catch (Exception ignored) {
                // Keep the HTTP status when the engine returns a non-JSON error.
            }
            throw new IOException(message);
        } finally {
            connection.disconnect();
        }
    }

    private static String readJson(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (data.size() + count > limit) throw new IOException("Local inference response is too large.");
            data.write(buffer, 0, count);
        }
        return data.toString("UTF-8");
    }

    @Override
    protected void handleOnDestroy() {
        requests.shutdownNow();
        super.handleOnDestroy();
    }
}
