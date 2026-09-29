import { AssistantsDialog } from "./AssistantsDialog";
import { closeAssistants, useAssistantsSelection } from "./launcher-store";

export {
  openAssistantEditor,
  openAssistants,
  registerAssistantsPanelHost,
  useAssistantsModalClosures,
} from "./launcher-store";

export function AssistantLauncher() {
  const current = useAssistantsSelection();
  return (
    <AssistantsDialog
      open={current !== null}
      initialTaskId={current?.taskId}
      initialEditId={current?.editId}
      initialCreate={current?.create}
      key={current?.request ?? "closed"}
      onClose={closeAssistants}
    />
  );
}
