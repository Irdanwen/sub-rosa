import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../../lib/i18n";

type Props = {
  children: ReactNode;
  /** What failed to render: one message, or the whole conversation. */
  scope: "message" | "conversation";
  /** What the children render from. A change lets the boundary try again (the
   * data it failed on changed). An array is compared item by item, so a row can
   * list every prop it reads without a fresh array counting as a change. */
  resetKey?: unknown;
};

function sameResetKey(left: unknown, right: unknown) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}

/**
 * Keeps a transcript that fails to render from taking the workspace down with
 * it. One bad message is replaced by a quiet line and the rest of the
 * conversation stays readable; the composer, the sidebar and a running turn are
 * untouched. The boundary retries when its `resetKey` changes, so a message
 * that failed while it was streaming gets another chance with the next frame,
 * and the reader can ask for another attempt when nothing is left to change.
 */
export class TranscriptErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // biome-ignore lint/suspicious/noConsole: a render failure must stay visible to developers
    console.error(`[agent] ${this.props.scope} failed to render`, error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.failed && !sameResetKey(previous.resetKey, this.props.resetKey)) {
      this.setState({ failed: false });
    }
  }

  private readonly retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="agent-render-error" role="status">
        {this.props.scope === "message"
          ? t("This message could not be displayed.")
          : t("This conversation could not be displayed. Your messages are still saved.")}{" "}
        <button type="button" className="agent-render-error-retry" onClick={this.retry}>
          {t("Try again")}
        </button>
      </p>
    );
  }
}
