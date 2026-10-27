export async function api<T>(path: string, options: RequestInit = {}, externalSignal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(path, {
      ...options,
      headers: { Accept: 'application/json', ...options.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch {
      throw new Error(`서버가 JSON을 반환하지 않았습니다. (${response.status}) API 서버와 프록시를 확인해 주세요.`);
    }
    if (!response.ok) {
      const error = body as { message?: string; detail?: string } | null;
      throw new Error(error?.message ?? error?.detail ?? `요청에 실패했습니다. (${response.status})`);
    }
    return body as T;
  } catch (error) {
    if (timedOut) throw new Error(`요청 시간이 ${timeoutMs / 1000}초를 초과했습니다. 데이터 크기를 줄이거나 서버 상태를 확인해 주세요.`);
    if (externalSignal?.aborted) throw new Error('실험을 중지했습니다. 완료되지 않은 결과는 저장하지 않았습니다.');
    if (error instanceof TypeError) throw new Error('API에 연결할 수 없습니다. 서버와 PostgreSQL 실행 상태를 확인해 주세요.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}
