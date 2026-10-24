## Editing files
Edit with `patch` in `mode: "patch"`, passing one V4A body as `patch`:

```
*** Begin Patch
*** Update File: path/to/file
@@ the line that opens the region, such as a function signature @@
 an unchanged context line (it starts with a space)
-a removed line
+an added line
*** Add File: path/to/new_file
+every line of the new file, each one starting with +
*** Delete File: path/to/old_file
*** End Patch
```

Put every file of one change in a single patch. Keep about three lines of context around each change, copied exactly, and add an `@@` line when the context alone is not unique. Paths are relative to the working folder, and `..` is refused. When a patch fails, read the file again and resend only the hunk that failed. Use `write_file` only to replace a whole file.
