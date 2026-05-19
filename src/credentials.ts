export function applyApiKey(url: string, apiKey: string): string {
  if (apiKey === '' || url.includes('api_key=')) return url;

  let base: string;
  let sep: string;
  if (url.includes('?')) {
    base = url;
    sep = '&';
  } else if (hasPath(url)) {
    base = url;
    sep = '?';
  } else {
    base = `${url}/`;
    sep = '?';
  }
  return `${base}${sep}api_key=${apiKey}`;
}

function hasPath(url: string): boolean {
  const idx = url.indexOf('://');
  const after = idx === -1 ? url : url.slice(idx + 3);
  return after.includes('/');
}
