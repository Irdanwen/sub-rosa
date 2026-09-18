/**
 * Builds the CFBundleVersion App Store Connect will accept.
 *
 * CFBundleShortVersionString is the version a person reads. CFBundleVersion is
 * a counter Apple requires to be unique and strictly higher than the last one
 * uploaded, so it cannot be the app version: a delivery refused for any reason
 * could never be sent again under its own version.
 *
 * The counter is the last of three numbers rather than the whole string. App
 * Store Connect answered 409 against previousBundleVersion "1.65.2" when the
 * counter was sent bare as "62", so a plain integer is not read as higher than
 * a three-part version. Keeping the app's major and minor in front makes each
 * build higher than the last of its train, and every train higher than the one
 * before it.
 */
export function iosBuildNumber(version, counter) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version: ${version}`);
  if (counter === undefined || counter === "") return version;
  if (!/^\d+$/.test(counter)) throw new Error(`Unexpected build counter: ${counter}`);
  return `${version.split(".").slice(0, 2).join(".")}.${counter}`;
}
