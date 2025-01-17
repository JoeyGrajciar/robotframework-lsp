package robocorp.lsp.intellij;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.event.EditorFactoryEvent;
import com.intellij.openapi.editor.event.EditorFactoryListener;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

public class LanguageServerEditorListener implements EditorFactoryListener {
    private static final Logger LOG = Logger.getInstance(LanguageServerEditorListener.class);

    public LanguageServerEditorListener() {
        LOG.debug("Created LanguageServerEditorListener");
    }

    @Override
    public void editorCreated(@NotNull EditorFactoryEvent event) {
        Editor editor = event.getEditor();
        editorCreated(EditorToLSPEditor.wrap(editor));
    }

    @Override
    public void editorReleased(@NotNull EditorFactoryEvent event) {
        Editor editor = event.getEditor();
        EditorLanguageServerConnection conn = EditorLanguageServerConnection.getFromUserData(editor);
        if (conn != null) {
            try {
                conn.editorReleased();
            } catch (Exception e) {
                LOG.error(e);
            }
        }
    }

    public void editorCreated(ILSPEditor editor) {
        @Nullable LanguageServerDefinition definition = editor.getLanguageDefinition();
        if (definition == null) {
            return;
        }

        String uri = editor.getURI();
        String projectPath = editor.getProjectPath();
        Project project = editor.getProject();
        if (uri == null || projectPath == null || project == null) {
            return;
        }

        try {
            LanguageServerManager manager = LanguageServerManager.start(definition, definition.ext.iterator().next(), projectPath, project);
            EditorLanguageServerConnection.editorCreated(manager, editor);
        } catch (Exception e) {
            LOG.error(e);
        }
    }
}
