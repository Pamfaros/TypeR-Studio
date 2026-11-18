package fr.scanr.typerstudio;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The files of the user, for the page (web/mobile.js). A web view only hands out copies of files;
 * here they are opened where they are, on the device, on a USB key or in a cloud's folder, and
 * the right to come back to them is kept: Save writes over the file that was opened.
 *
 * The page never gets a path. It gets a token: the address the system gives for a document the
 * user picked, or for one in a folder they picked. Only those can be reached with one.
 */
@CapacitorPlugin(name = "TypeRFiles")
public class TypeRFilesPlugin extends Plugin {

    // Android keeps a limited number of lasting accesses for an app: the oldest ones go
    private static final int KEPT = 300;
    private static final int LASTING = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private static class Writing {

        File temporary;
        FileOutputStream stream;
        Uri uri;
    }

    private final Map<String, Writing> writes = new HashMap<>();
    // What the system asked the app to open before the page was there to take it
    private final JSArray waiting = new JSArray();

    @Override
    public void load() {
        clear(new File(getContext().getCacheDir(), "typer-write"));
        getActivity()
            .getOnBackPressedDispatcher()
            .addCallback(
                getActivity(),
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        bridge.triggerWindowJSEvent("typerBack");
                    }
                }
            );
        open(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        open(intent);
    }

    private static void clear(File folder) {
        File[] inside = folder.listFiles();
        if (inside != null) for (File file : inside) file.delete();
    }

    private ContentResolver resolver() {
        return getContext().getContentResolver();
    }

    private void fail(PluginCall call, Exception error) {
        String code = error instanceof FileNotFoundException ? "NOT_FOUND" : error instanceof SecurityException ? "DENIED" : null;
        call.reject(error.getMessage() != null ? error.getMessage() : error.toString(), code, error);
    }

    /* ---------------------------------- tokens ---------------------------------- */

    private Uri uriOf(PluginCall call, String key) throws FileNotFoundException {
        String token = call.getString(key);
        if (token == null || !token.startsWith("content://")) throw new FileNotFoundException("Not a file of this app.");
        return Uri.parse(token);
    }

    private boolean inTree(Uri uri) {
        List<String> parts = uri.getPathSegments();
        return parts.size() >= 2 && "tree".equals(parts.get(0));
    }

    private JSObject facts(Uri uri) throws FileNotFoundException {
        String[] columns = { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_MIME_TYPE };
        try (Cursor cursor = resolver().query(uri, null, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new FileNotFoundException("This file can't be found any more.");
            JSObject facts = new JSObject();
            int name = cursor.getColumnIndex(columns[0]);
            int size = cursor.getColumnIndex(columns[1]);
            int modified = cursor.getColumnIndex(columns[2]);
            int type = cursor.getColumnIndex(columns[3]);
            facts.put("name", name >= 0 && !cursor.isNull(name) ? cursor.getString(name) : uri.getLastPathSegment());
            facts.put("size", size >= 0 && !cursor.isNull(size) ? cursor.getLong(size) : 0);
            facts.put("modified", modified >= 0 && !cursor.isNull(modified) ? cursor.getLong(modified) : 0);
            facts.put("kind", type >= 0 && Document.MIME_TYPE_DIR.equals(cursor.getString(type)) ? "directory" : "file");
            return facts;
        } catch (SecurityException | IllegalArgumentException error) {
            throw new FileNotFoundException("This file can't be found any more.");
        }
    }

    private JSObject entry(String kind, String name, Uri uri) {
        JSObject entry = new JSObject();
        entry.put("kind", kind);
        entry.put("name", name);
        entry.put("token", uri.toString());
        return entry;
    }

    private void keep(Uri uri) {
        try {
            resolver().takePersistableUriPermission(uri, LASTING);
        } catch (SecurityException readOnly) {
            try {
                resolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException none) {
                // For this run of the app only
            }
        }
        List<UriPermission> kept = new ArrayList<>(resolver().getPersistedUriPermissions());
        kept.sort((a, b) -> Long.compare(b.getPersistedTime(), a.getPersistedTime()));
        for (int at = KEPT; at < kept.size(); at++) {
            try {
                resolver().releasePersistableUriPermission(kept.get(at).getUri(), LASTING);
            } catch (SecurityException gone) {
                // Already let go
            }
        }
    }

    /* ---------------------------------- pickers --------------------------------- */

    private void near(PluginCall call, Intent intent) {
        String near = call.getString("near");
        if (near != null && near.startsWith("content://") && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(near));
        }
    }

    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, Boolean.TRUE.equals(call.getBoolean("multiple", false)));
        intent.addFlags(LASTING | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        near(call, intent);
        startActivityForResult(call, intent, "filesPicked");
    }

    @ActivityCallback
    private void filesPicked(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("Cancelled.", "ABORT");
            return;
        }
        List<Uri> picked = new ArrayList<>();
        ClipData several = data.getClipData();
        if (several != null) for (int at = 0; at < several.getItemCount(); at++) picked.add(several.getItemAt(at).getUri());
        else if (data.getData() != null) picked.add(data.getData());
        JSArray files = new JSArray();
        for (Uri uri : picked) {
            keep(uri);
            try {
                files.put(entry("file", facts(uri).getString("name"), uri));
            } catch (FileNotFoundException error) {
                // Gone between the pick and now
            }
        }
        if (files.length() == 0) {
            call.reject("Nothing was picked.", "ABORT");
            return;
        }
        JSObject answer = new JSObject();
        answer.put("files", files);
        call.resolve(answer);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(LASTING | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        near(call, intent);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("Cancelled.", "ABORT");
            return;
        }
        Uri tree = data.getData();
        keep(tree);
        Uri folder = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        try {
            call.resolve(entry("directory", facts(folder).getString("name"), folder));
        } catch (FileNotFoundException error) {
            fail(call, error);
        }
    }

    private static String typeOf(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".psd") || lower.endsWith(".psb")) return "image/vnd.adobe.photoshop";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".zip")) return "application/zip";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    // Save As: the system's own screen makes an empty file where the user says, and that file is
    // then written like any other
    @PluginMethod
    public void createFile(PluginCall call) {
        String name = call.getString("name", "Untitled");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(typeOf(name));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        intent.addFlags(LASTING | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        near(call, intent);
        startActivityForResult(call, intent, "fileCreated");
    }

    @ActivityCallback
    private void fileCreated(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("Cancelled.", "ABORT");
            return;
        }
        Uri uri = data.getData();
        keep(uri);
        try {
            call.resolve(entry("file", facts(uri).getString("name"), uri));
        } catch (FileNotFoundException error) {
            fail(call, error);
        }
    }

    /* ---------------------------------- reading --------------------------------- */

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            call.resolve(facts(uriOf(call, "token")));
        } catch (FileNotFoundException error) {
            fail(call, error);
        }
    }

    // The page reads the document through the app's own address: nothing to copy here
    @PluginMethod
    public void read(PluginCall call) {
        try {
            JSObject answer = new JSObject();
            answer.put("path", uriOf(call, "token").toString());
            call.resolve(answer);
        } catch (FileNotFoundException error) {
            fail(call, error);
        }
    }

    @PluginMethod
    public void release(PluginCall call) {
        call.resolve();
    }

    /* ---------------------------------- writing --------------------------------- */

    @PluginMethod
    public void writeBegin(PluginCall call) {
        try {
            Writing writing = new Writing();
            writing.uri = uriOf(call, "token");
            File folder = new File(getContext().getCacheDir(), "typer-write");
            folder.mkdirs();
            String id = UUID.randomUUID().toString();
            writing.temporary = new File(folder, id);
            writing.stream = new FileOutputStream(writing.temporary);
            writes.put(id, writing);
            JSObject answer = new JSObject();
            answer.put("id", id);
            call.resolve(answer);
        } catch (IOException error) {
            fail(call, error);
        }
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        Writing writing = writes.get(call.getString("id", ""));
        if (writing == null) {
            call.reject("No such write.");
            return;
        }
        try {
            writing.stream.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (IOException | IllegalArgumentException error) {
            fail(call, error);
        }
    }

    private OutputStream emptied(Uri uri) throws IOException {
        // "wt" empties the document first; some storages only know one of the other two
        for (String mode : new String[] { "wt", "rwt", "w" }) {
            try {
                OutputStream stream = resolver().openOutputStream(uri, mode);
                if (stream != null) return stream;
            } catch (FileNotFoundException | IllegalArgumentException | UnsupportedOperationException error) {
                if ("w".equals(mode)) throw new IOException(error.getMessage(), error);
            }
        }
        throw new IOException("This file can't be written.");
    }

    private static void pour(InputStream from, OutputStream to) throws IOException {
        byte[] buffer = new byte[1 << 20];
        int count;
        while ((count = from.read(buffer)) > 0) to.write(buffer, 0, count);
        to.flush();
    }

    // The whole file is there before the document is touched. What the document held is set
    // aside first, and put back if the writing fails halfway.
    @PluginMethod
    public void writeEnd(PluginCall call) {
        Writing writing = writes.remove(call.getString("id", ""));
        if (writing == null) {
            call.reject("No such write.");
            return;
        }
        File backup = new File(writing.temporary.getPath() + ".before");
        try {
            writing.stream.close();
            boolean kept = false;
            try (InputStream from = resolver().openInputStream(writing.uri); OutputStream to = new FileOutputStream(backup)) {
                if (from != null) {
                    pour(from, to);
                    kept = true;
                }
            } catch (IOException | SecurityException error) {
                // A new, empty document, or one that can't be read back: nothing to set aside
            }
            try (InputStream from = new FileInputStream(writing.temporary); OutputStream to = emptied(writing.uri)) {
                pour(from, to);
            } catch (IOException | SecurityException error) {
                if (kept) {
                    try (InputStream from = new FileInputStream(backup); OutputStream to = emptied(writing.uri)) {
                        pour(from, to);
                    } catch (IOException | SecurityException lost) {
                        // The storage is gone: the page still holds the document
                    }
                }
                throw error;
            }
            call.resolve(facts(writing.uri));
        } catch (IOException | SecurityException error) {
            fail(call, error);
        } finally {
            writing.temporary.delete();
            backup.delete();
        }
    }

    @PluginMethod
    public void writeAbort(PluginCall call) {
        Writing writing = writes.remove(call.getString("id", ""));
        if (writing != null) {
            try {
                writing.stream.close();
            } catch (IOException error) {
                // Nothing more to do with it
            }
            writing.temporary.delete();
        }
        call.resolve();
    }

    /* ---------------------------------- folders --------------------------------- */

    @PluginMethod
    public void access(PluginCall call) {
        JSObject answer = new JSObject();
        boolean granted = false;
        try {
            Uri uri = uriOf(call, "token");
            facts(uri);
            granted = !Boolean.TRUE.equals(call.getBoolean("write", false)) ||
            getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
        } catch (FileNotFoundException error) {
            // Not there any more
        }
        answer.put("granted", granted);
        call.resolve(answer);
    }

    private static String documentOf(Uri uri) {
        try {
            return uri.getAuthority() + "\n" + DocumentsContract.getDocumentId(uri);
        } catch (IllegalArgumentException error) {
            return uri.toString();
        }
    }

    @PluginMethod
    public void same(PluginCall call) {
        JSObject answer = new JSObject();
        try {
            answer.put("same", documentOf(uriOf(call, "a")).equals(documentOf(uriOf(call, "b"))));
        } catch (FileNotFoundException error) {
            answer.put("same", false);
        }
        call.resolve(answer);
    }

    private JSArray inside(Uri folder) throws FileNotFoundException {
        if (!inTree(folder)) throw new FileNotFoundException("Not a folder of this app.");
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(folder, DocumentsContract.getDocumentId(folder));
        String[] columns = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE };
        JSArray entries = new JSArray();
        try (Cursor cursor = resolver().query(children, columns, null, null, null)) {
            if (cursor == null) throw new FileNotFoundException("This folder can't be found any more.");
            while (cursor.moveToNext()) {
                String name = cursor.getString(1);
                if (name == null || name.startsWith(".")) continue;
                entries.put(entry(Document.MIME_TYPE_DIR.equals(cursor.getString(2)) ? "directory" : "file", name, DocumentsContract.buildDocumentUriUsingTree(folder, cursor.getString(0))));
            }
        } catch (SecurityException | IllegalArgumentException error) {
            throw new FileNotFoundException("This folder can't be found any more.");
        }
        return entries;
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            JSObject answer = new JSObject();
            answer.put("entries", inside(uriOf(call, "token")));
            call.resolve(answer);
        } catch (FileNotFoundException error) {
            fail(call, error);
        }
    }

    @PluginMethod
    public void child(PluginCall call) {
        try {
            Uri folder = uriOf(call, "token");
            String name = call.getString("name", "");
            boolean wanted = "directory".equals(call.getString("kind"));
            if (name.isEmpty() || name.contains("/")) throw new SecurityException("Refused name.");
            JSArray entries = inside(folder);
            for (int at = 0; at < entries.length(); at++) {
                JSObject found = JSObject.fromJSONObject(entries.getJSONObject(at));
                if (!name.equals(found.getString("name"))) continue;
                if ("directory".equals(found.getString("kind")) != wanted) {
                    call.reject(name + " is not a " + (wanted ? "folder" : "file") + ".", "MISMATCH");
                    return;
                }
                call.resolve(found);
                return;
            }
            if (!Boolean.TRUE.equals(call.getBoolean("create", false))) {
                call.reject(name + " is not in this folder.", "NOT_FOUND");
                return;
            }
            Uri made = DocumentsContract.createDocument(resolver(), folder, wanted ? Document.MIME_TYPE_DIR : typeOf(name), name);
            if (made == null) throw new FileNotFoundException(name + " can't be made in this folder.");
            call.resolve(entry(wanted ? "directory" : "file", facts(made).getString("name"), made));
        } catch (Exception error) {
            fail(call, error);
        }
    }

    // Where a storage names its documents by their place, as the device's own does, the way
    // from a folder down to a file is read from those names
    @PluginMethod
    public void resolve(PluginCall call) {
        JSObject answer = new JSObject();
        try {
            Uri folder = uriOf(call, "token");
            Uri inner = uriOf(call, "child");
            String from = DocumentsContract.getDocumentId(folder);
            String to = DocumentsContract.getDocumentId(inner);
            if (folder.getAuthority() != null && folder.getAuthority().equals(inner.getAuthority()) && to.startsWith(from.endsWith(":") ? from : from + "/")) {
                JSArray path = new JSArray();
                for (String part : to.substring(from.endsWith(":") ? from.length() : from.length() + 1).split("/")) path.put(part);
                answer.put("path", path);
            }
        } catch (FileNotFoundException | IllegalArgumentException error) {
            // No way to tell
        }
        call.resolve(answer);
    }

    /* --------------------------- opened from another app -------------------------- */

    // « Open with TypeR Studio » in a file manager, or a file shared to the app. With the right
    // to write, Save will write over it; otherwise it is only read.
    private void open(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        List<Uri> given = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) given.add(intent.getData());
        else if (Intent.ACTION_SEND.equals(action)) {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) given.add(one);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> several = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (several != null) given.addAll(several);
        }
        // Text shared as it is, without a file: a script (web/mobile.js)
        CharSequence said = given.isEmpty() && Intent.ACTION_SEND.equals(action) ? intent.getCharSequenceExtra(Intent.EXTRA_TEXT) : null;
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        // Taken once: turning the screen starts the app's window again with the same request
        intent.setAction(Intent.ACTION_MAIN);
        JSArray files = new JSArray();
        if (said != null && said.toString().trim().length() > 0) {
            JSObject script = new JSObject();
            script.put("text", said.toString());
            script.put("name", subject == null ? "" : subject);
            files.put(script);
        }
        for (Uri uri : given) {
            if (!"content".equals(uri.getScheme())) continue;
            try {
                JSObject file = entry("file", facts(uri).getString("name"), uri);
                file.put("lasting", getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED);
                files.put(file);
            } catch (FileNotFoundException error) {
                // Not readable: nothing to open
            }
        }
        if (files.length() == 0) return;
        if (hasListeners("open")) {
            JSObject data = new JSObject();
            data.put("files", files);
            notifyListeners("open", data);
        } else {
            try {
                for (int at = 0; at < files.length(); at++) waiting.put(files.get(at));
            } catch (org.json.JSONException error) {
                // Never: these were just put there
            }
        }
    }

    @PluginMethod
    public void opened(PluginCall call) {
        JSObject answer = new JSObject();
        JSArray files = new JSArray();
        try {
            while (waiting.length() > 0) files.put(waiting.remove(0));
        } catch (Exception error) {
            // Nothing waiting
        }
        answer.put("files", files);
        call.resolve(answer);
    }

    /* ----------------------------------- looks ---------------------------------- */

    // What shows around the page (behind the clock and the system's buttons) takes the theme's colour
    @PluginMethod
    public void setBackground(PluginCall call) {
        try {
            int color = Color.parseColor(call.getString("color", ""));
            getActivity()
                .runOnUiThread(() -> {
                    getActivity().getWindow().getDecorView().setBackgroundColor(color);
                    Object parent = bridge.getWebView().getParent();
                    if (parent instanceof View) ((View) parent).setBackgroundColor(color);
                    bridge.getWebView().setBackgroundColor(color);
                });
        } catch (IllegalArgumentException error) {
            // Not a colour: the bars stay as they are
        }
        call.resolve();
    }

    // The back button with nothing left to close: the app steps aside with its pages open
    @PluginMethod
    public void background(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }
}
