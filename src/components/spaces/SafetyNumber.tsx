/** Twelve groups of five digits, laid out to be read aloud. */
export function SafetyNumber({ groups }: { groups: string[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="spaces-safety-digits">
      {groups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the groups are positional by nature
        <span key={index} className="spaces-safety-group">
          {group}
        </span>
      ))}
    </div>
  );
}
