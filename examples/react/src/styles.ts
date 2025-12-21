/**
 * Shared styles for Durably React Example
 */

export const styles = {
  container: {
    padding: '2rem',
    fontFamily: 'system-ui',
    maxWidth: '800px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
  },
  links: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
  },
  linkSeparator: {
    color: '#999',
  },
  tabs: {
    display: 'flex',
    gap: 0,
    marginBottom: '1.5rem',
    borderBottom: '2px solid #e0e0e0',
  },
  tab: (active: boolean) => ({
    padding: '0.75rem 1.5rem',
    background: 'none',
    border: 'none',
    fontSize: '1rem',
    cursor: 'pointer',
    borderBottom: active ? '2px solid #007bff' : '2px solid transparent',
    marginBottom: '-2px',
    color: active ? '#007bff' : '#666',
    fontWeight: active ? 500 : 400,
  }),
  buttons: { display: 'flex', gap: '1rem', marginBottom: '2rem' },
  result: (isError: boolean) => ({
    background: isError ? '#fee' : '#f5f5f5',
    padding: '1rem',
    borderRadius: '4px',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap' as const,
  }),
}
