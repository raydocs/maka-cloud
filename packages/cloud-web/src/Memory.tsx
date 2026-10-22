import { useRef, useState } from 'react';
import { Button } from '@astryxdesign/core';
import { BRAND, type CloudClient, displayText, type MemoryProfile } from '@maka-cloud/client';

/** The invite's profile, not the selected conversation's. Unmounted on disconnect. */
export function MemoryPanel({
  client,
  errorText,
}: {
  client: CloudClient;
  errorText: (error: unknown) => string;
}) {
  const [profile, setProfile] = useState<MemoryProfile>({ facts: [], summaries: [] });
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);

  async function act(work: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
      setProfile(await client.memory());
      setLoaded(true);
    } catch (error) {
      setError(errorText(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <details
      className="memory-panel"
      onToggle={(event) => {
        if (event.currentTarget.open) void act(async () => {});
      }}
    >
      <summary>
        <span>Memory</span>
        <span className="muted">What {BRAND.name} remembers about you</span>
      </summary>
      <section aria-label="Your memory" className="memory-content">
        <h2>Your saved facts</h2>
        <p className="muted">Used in all your conversations, from the next message on.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loaded && !error && <p role="status">Loading memory…</p>}
        {loaded && profile.facts.length === 0 && <p>No saved facts yet.</p>}
        <ul className="memory-facts">
          {profile.facts.map((fact) => (
            <li key={fact.id}>
              {editing?.id === fact.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      await client.editFact(fact.id, editing.text);
                      setEditing(null);
                    });
                  }}
                >
                  <label>
                    Edit fact
                    <textarea
                      maxLength={500}
                      value={editing.text}
                      disabled={busy}
                      onChange={(event) =>
                        setEditing({ id: fact.id, text: displayText(event.target.value) })
                      }
                    />
                  </label>
                  <div className="task-actions">
                    <Button
                      label="Save changes"
                      variant="primary"
                      type="submit"
                      isDisabled={busy || !editing.text.trim()}
                    />
                    <Button
                      label="Cancel edit"
                      variant="secondary"
                      isDisabled={busy}
                      onClick={() => setEditing(null)}
                    />
                  </div>
                </form>
              ) : (
                <>
                  <p>{displayText(fact.text)}</p>
                  <div className="task-actions">
                    <Button
                      label="Edit"
                      variant="secondary"
                      isDisabled={busy}
                      onClick={() => setEditing({ id: fact.id, text: displayText(fact.text) })}
                    />
                    <Button
                      label="Delete"
                      variant="secondary"
                      isDisabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await client.deleteFact(fact.id);
                        })
                      }
                    />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await client.addFact(draft);
              setDraft('');
            });
          }}
        >
          <label>
            Add a fact
            <textarea
              rows={2}
              maxLength={500}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(displayText(event.target.value))}
            />
          </label>
          <Button
            label="Save fact"
            variant="primary"
            type="submit"
            isDisabled={busy || !draft.trim() || !loaded}
          />
        </form>
        <h2>Recent task summaries</h2>
        <p className="muted">Short excerpts of delivered replies, not independent verification.</p>
        {loaded && profile.summaries.length === 0 && <p>No task summaries yet.</p>}
        <ul>
          {profile.summaries.map((summary) => (
            <li key={summary.id}>{displayText(summary.text)}</li>
          ))}
        </ul>
        <p className="muted">A fact you delete stays forgotten.</p>
      </section>
    </details>
  );
}
