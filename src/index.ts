import type { Env, GenerateQueueMessage } from './types';
import { handleGenerateMessage } from './pipeline/generate';
import { runRetentionPurge } from './lib/retention';
import { handleIntake } from './routes/intake';
import { handleDownload } from './routes/download';
import {
  handleReviewAction,
  handleReviewCase,
  handleReviewList,
  handleReviewLogin,
} from './routes/review';
import { handleStatusApi, handleStatusPage } from './routes/status';
import { json, notFound } from './lib/http';
import { assertHumanMode } from './lib/safety';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    assertHumanMode(env);
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // API
      if (pathname === '/api/intake' && request.method === 'POST') {
        return handleIntake(request, env);
      }

      const statusApi = pathname.match(/^\/api\/status\/([^/]+)$/);
      if (statusApi && request.method === 'GET') {
        return handleStatusApi(request, env, decodeURIComponent(statusApi[1]));
      }

      const download = pathname.match(/^\/api\/download\/([^/]+)$/);
      if (download && request.method === 'GET') {
        return handleDownload(request, env, decodeURIComponent(download[1]));
      }

      // Student status HTML
      const statusPage = pathname.match(/^\/status\/([^/]+)$/);
      if (statusPage && request.method === 'GET') {
        return handleStatusPage(request, env, decodeURIComponent(statusPage[1]));
      }

      // Reviewer UI
      if (pathname === '/review/login') {
        return handleReviewLogin(request, env);
      }
      if (pathname === '/review' && request.method === 'GET') {
        return handleReviewList(request, env);
      }
      const reviewCase = pathname.match(/^\/review\/([^/]+)$/);
      if (reviewCase && request.method === 'GET') {
        return handleReviewCase(request, env, decodeURIComponent(reviewCase[1]));
      }
      const reviewAction = pathname.match(/^\/review\/([^/]+)\/(approve|revise|reject)$/);
      if (reviewAction && request.method === 'POST') {
        return handleReviewAction(
          request,
          env,
          decodeURIComponent(reviewAction[1]),
          reviewAction[2] as 'approve' | 'revise' | 'reject',
        );
      }

      // Static assets (landing page under /green-river-college/)
      if (env.ASSETS) {
        if (pathname === '/' || pathname === '/green-river-college' || pathname === '/green-river-college/') {
          const assetReq = new Request(new URL('/green-river-college/index.html', url.origin), request);
          return env.ASSETS.fetch(assetReq);
        }
        const assetResp = await env.ASSETS.fetch(request);
        if (assetResp.status !== 404) return assetResp;
      }

      if (pathname === '/health') {
        return json({ ok: true, service: 'fixline-grc' });
      }

      return notFound();
    } catch (err) {
      // Never log résumé bodies. Generic error only.
      console.error('request_error', err instanceof Error ? err.message : 'unknown');
      return json({ message: 'Internal error' }, 500);
    }
  },

  async queue(batch: MessageBatch<GenerateQueueMessage>, env: Env): Promise<void> {
    assertHumanMode(env);
    for (const message of batch.messages) {
      try {
        await handleGenerateMessage(env, message.body);
        message.ack();
      } catch (err) {
        console.error('queue_error', err instanceof Error ? err.message : 'unknown');
        message.retry();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    assertHumanMode(env);
    ctx.waitUntil(
      (async () => {
        const result = await runRetentionPurge(env);
        console.log('retention_purge', result.scanned, result.deleted);
      })(),
    );
  },
};
