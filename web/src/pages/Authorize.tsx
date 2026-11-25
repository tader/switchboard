import { useEffect, useState } from 'react';
import { api, type Connection } from '../api';
import { useSession } from '../auth';
import { AccessPicker } from '../components/AccessPicker';
import { Alert, Button, Spinner } from '../components/ui';
import { AuthCard } from './Login';

/** Consent page for apps (such as another Switchboard) asking for a token through OAuth. */
export function Authorize() {
  const { user } = useSession();
  const params = Object.fromEntries(new URLSearchParams(location.search));
  const [request, setRequest] = useState<{ client: string; verifiedName: boolean; domain: string | null; redirectHost: string; forMcp: boolean; secure: boolean } | null>();
  const [certificateError,setCertificateError]=useState(false);
  const [review,setReview]=useState<any>(null);
  const [reviewBusy,setReviewBusy]=useState(false);
  const [verified,setVerified]=useState(false);
  const [error, setError] = useState('');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [limited, setLimited] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);

  useEffect(() => {
    api(`/oauth/authorize${location.search}`).then(setRequest, (e) => {
      setError(e.message);
      setCertificateError(e.code === 'oauth_metadata_certificate_untrusted');
      setRequest(null);
    });
    api<Connection[]>('/connections').then(setConnections, () => {});
  }, []);

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'allow' : 'deny');
    setError('');
    try {
      const r = await api<{ redirect: string }>('/oauth/authorize', { body: { ...params, approve, connectionIds: limited ? selected : null } });
      location.href = r.redirect;
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
      if(e.code === 'oauth_metadata_certificate_untrusted'){setCertificateError(true);setRequest(null);setReview(null);setVerified(false);}
    }
  };

  if (request === undefined) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (!request) {
    return (
      <AuthCard title={certificateError ? 'Review the connection certificate' : 'This request is not valid'}>
        <div className="space-y-4">
        <Alert>{error}</Alert>
        {certificateError && <>
          <p className="text-sm break-all">{new URL(params.client_id).host}</p>
          {user.role !== 'admin' ? <p className="text-sm">Ask your Switchboard administrator to review this certificate.</p> : <>
            <p className="text-sm">Your workplace may inspect secure connections. Verify this fingerprint with IT before trusting it.</p>
            {!review ? <Button loading={reviewBusy} onClick={async()=>{setReviewBusy(true);try{setReview(await api('/oauth/authorize/certificate-review',{body:{client_id:params.client_id}}));}catch(e:any){setError(e.message);}finally{setReviewBusy(false);}}}>Review certificate</Button> : <>
              <dl className="space-y-2 text-xs break-all">{[['Host',review.origin],['Subject',review.subject],['Issuer',review.issuer],['Valid from',review.validFrom],['Expires',review.validTo],['SHA-256 fingerprint',review.fingerprint]].map(([label,value])=><div key={label}><dt className="text-zinc-500">{label}</dt><dd className="whitespace-pre-wrap">{value}</dd></div>)}</dl>
              <p className="text-sm">Trust applies only to OAuth client metadata for this host and port.</p>
              <label className="flex gap-2 text-sm"><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)}/>I verified this fingerprint with IT.</label>
              <Button variant="primary" disabled={!verified||reviewBusy} loading={reviewBusy} onClick={async()=>{setReviewBusy(true);try{await api('/oauth/authorize/certificate-trust',{body:{reviewToken:review.reviewToken}});location.reload();}catch(e:any){setError(e.message);setReview(null);setVerified(false);}finally{setReviewBusy(false);}}}>Trust for this host and retry</Button>
            </>}
          </>}
          <Button onClick={()=>location.reload()}>Retry</Button>
        </>}
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={`Allow ${request.client} to use your account?`} subtitle={`Signed in as ${user.username}`}>
      <div className="space-y-5">
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-zinc-500">App</dt>
          <dd className="min-w-0 break-words">
            {request.client}
            {!request.verifiedName && <span className="text-zinc-400"> (name given by the app)</span>}
          </dd>
          {request.domain && !request.verifiedName && (
            <>
              <dt className="text-zinc-500">From</dt>
              <dd className="min-w-0 break-words font-medium">{request.domain}</dd>
            </>
          )}
          <dt className="text-zinc-500">Returns to</dt>
          <dd className="min-w-0 break-words">{request.redirectHost}</dd>
        </dl>
        <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          {request.forMcp ? (
            <>It can use the connections you choose through Switchboard’s MCP server, as <b>{user.username}</b>.</>
          ) : (
            <>It gets an API token for <b>{user.username}</b>.</>
          )}{' '}
          You can revoke access any time on the API tokens page.
        </p>
        {!request.secure && <Alert tone="amber">{request.redirectHost} does not use HTTPS.</Alert>}
        <AccessPicker connections={connections} limited={limited} setLimited={setLimited} selected={selected} setSelected={setSelected} />
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => decide(false)} loading={busy === 'deny'} disabled={!!busy}>
            Deny
          </Button>
          <Button className="flex-1" variant="primary" onClick={() => decide(true)} loading={busy === 'allow'} disabled={!!busy || (limited && !selected.length)}>
            Allow
          </Button>
        </div>
      </div>
    </AuthCard>
  );
}
