-- Applied by migration role after every successful migration, never by runtime.
REVOKE ALL ON TABLE public._sqlx_migrations FROM subrosa_runtime;
