package fr.scanr.typerstudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NemesisWebViewTest {
    @Test
    public void restoresASelectionUsingThePackagedModel() throws Exception {
        try (ActivityScenario<MainActivity> app = ActivityScenario.launch(MainActivity.class)) {
            assertEquals("true", awaitValue(app,
                "Boolean(window.TypeRMobile?.platform === 'android' && window.TypeRGenerative && window.TypeRNemesis)", "true"));
            evaluate(app, """
                (() => {
                  window.nemesisTest = 'running';
                  const image = document.createElement('canvas');
                  const mask = document.createElement('canvas');
                  image.width = mask.width = 256;
                  image.height = mask.height = 256;
                  const input = image.getContext('2d');
                  input.fillStyle = '#4080c0';
                  input.fillRect(0, 0, 256, 256);
                  input.fillStyle = '#ff0000';
                  input.fillRect(115, 120, 24, 16);
                  const selection = mask.getContext('2d');
                  selection.fillStyle = '#fff';
                  selection.fillRect(0, 0, 256, 256);
                  selection.fillStyle = '#000';
                  selection.fillRect(115, 120, 24, 16);
                  const settings = window.TypeRGenerative.load();
                  settings.service = 'local';
                  settings.models.local = window.TypeRGenerative.NEMESIS_ID;
                  window.TypeRGenerative.generate({settings, canvas: image, mask}).then(bitmap => {
                    input.drawImage(bitmap, 0, 0);
                    bitmap.close();
                    const known = input.getImageData(0, 0, 1, 1).data;
                    const filled = input.getImageData(127, 128, 1, 1).data;
                    const unchanged = Array.from(known).join() === '64,128,192,255';
                    const removed = filled[1] > 80 && filled[2] > 100 && filled[0] < 120;
                    window.nemesisTest = unchanged && removed ? 'pass' : 'unexpected RGB: ' + known + ' / ' + filled;
                  }).catch(error => {
                    window.nemesisTest = String(error) + ' ' + (error.detail || '');
                  });
                })();
                """);
            assertEquals("\"pass\"", awaitValue(app, "window.nemesisTest", "\"pass\""));
        }
    }

    private static String awaitValue(ActivityScenario<MainActivity> app, String script, String expected)
        throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 60_000;
        String value;
        do {
            value = evaluate(app, script);
            if (expected.equals(value)) return value;
            if (value != null && value.startsWith("\"") && !value.equals("\"running\"")) return value;
            SystemClock.sleep(250);
        } while (SystemClock.elapsedRealtime() < deadline);
        return value;
    }

    private static String evaluate(ActivityScenario<MainActivity> app, String script)
        throws InterruptedException {
        CountDownLatch ready = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        app.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, result -> {
            value.set(result);
            ready.countDown();
        }));
        assertTrue("WebView did not respond", ready.await(10, TimeUnit.SECONDS));
        return value.get();
    }
}
