import { Component, type PropsWithRef, type ReactNode, Suspense, lazy, useState } from "react";
import { Spinner } from "../components/ui/Spinner";
import { t } from "../lib/i18n";
import "../styles/view-recovery.css";

type BoundaryProps = {
  children: ReactNode;
  onRetry: () => void;
  fullScreen: boolean;
};

class ViewErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section
        className={`view-recovery${this.props.fullScreen ? " view-recovery-full" : ""}`}
        aria-label={t("This view could not be displayed")}
      >
        <div className="view-recovery-content">
          <div role="alert">
            <h1>{t("This view could not be displayed")}</h1>
            <p>{t("Try again to reopen this view.")}</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={this.props.onRetry}>
            {t("Try again")}
          </button>
          {this.props.fullScreen ? (
            <div className="view-recovery-reload">
              <p>{t("If this keeps happening, reload the app. Unsaved edits may be lost.")}</p>
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                {t("Reload app")}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    );
  }
}

/**
 * Keep a failed view inside its own boundary, leaving the surrounding shell
 * usable. React.lazy caches rejected promises: resetting a boundary alone
 * cannot retry a chunk load, so every explicit retry also gets a new lazy type.
 * No automatic retries or reloads: remounting may discard transient edits.
 */
export function recoverableView<Props extends object>(
  load: () => Promise<{ default: (props: Props) => ReactNode }>,
  { fullScreen = false }: { fullScreen?: boolean } = {},
) {
  const InitialView = lazy(load);
  return function RecoverableView(props: Props) {
    const [attempt, setAttempt] = useState(() => ({ View: InitialView, version: 0 }));
    const { version } = attempt;
    const View = attempt.View;
    return (
      <ViewErrorBoundary
        key={version}
        fullScreen={fullScreen}
        onRetry={() => setAttempt({ View: lazy(load), version: version + 1 })}
      >
        <Suspense
          fallback={
            <div className={`view-recovery${fullScreen ? " view-recovery-full" : ""}`}>
              <Spinner aria-label={t("Loading")} />
            </div>
          }
        >
          <View key={version} {...(props as PropsWithRef<Props>)} />
        </Suspense>
      </ViewErrorBoundary>
    );
  };
}
