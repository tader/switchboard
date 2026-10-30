export default function setup(ctx: any) {
  const format = 'fixture/authentication/v1';
  const source = {
    id: 'source', name: 'Fixture source', fields: [{key:'secret',label:'Secret',type:'secret',required:true}],
    connect: ({config}:any) => ({credentials:{accessToken:config.secret,refreshToken:'fixture-refresh',generation:1},config:{},account:{id:'fixture-account',label:'Fixture account'}}),
    authorize() { throw new Error('Authentication sources do not proxy data'); },
    credentialProvider: { format, async provide(conn:any,opts:any) {
      const credentials = {...conn.credentials,generation:conn.credentials.generation+(opts.forceAuthentication?1:0)};
      return {bundle:{...credentials,expiresAt:Date.now()+60000},credentials:opts.forceAuthentication?credentials:undefined,account:conn.account};
    } },
  };
  const consumer = {
    id:'source', name:'Use source', fields:[{key:'authenticationSource',label:'Source',type:'credential-source',credentialFormat:format,required:true},{key:'endpoint',label:'Endpoint',type:'url',required:true},{key:'audience',label:'Audience',type:'select',default:'graph',options:[{value:'graph',label:'Graph'},{value:'outlook',label:'Outlook'}]}],
    credentialConsumer:{format,field:'authenticationSource'},
    async connect({config}:any) { const value=await ctx.credentials.obtain(config.authenticationSource,{format}); return {credentials:value.bundle,account:value.account}; },
    reusable:{kind:'oauth',format,context:(config:any)=>config.authenticationSource,configKeys:['authenticationSource'],requiredScopes:(config:any)=>[config.audience??'graph'],grantedScopes:()=>['graph','outlook'],validate:async()=>({id:'fixture-account',label:'Fixture account'}),allowRequest:(req:any,conn:any)=>req.url.origin===new URL(conn.config.endpoint).origin&&req.url.pathname==='/test'&&req.method==='GET',applyToken:(req:any,_conn:any,token:any)=>req.headers.set('authorization',`Bearer ${token.accessToken}`)},
    async token(conn:any,opts:any) {let credentials=conn.credentials;if(opts.force){credentials={...credentials,refreshToken:'fixture-rotated-refresh'};await opts.persistCredentials?.(credentials);credentials={...credentials,accessToken:credentials.accessToken+'-renewed'};}return {accessToken:credentials.accessToken+(conn.config.audience==='outlook'?'-outlook':''),expiresAt:credentials.expiresAt,credentials:opts.force?credentials:undefined};},
    async authorize(req:any,conn:any,opts:any) {
      let credentials=conn.credentials;
      if(opts.force || credentials.expiresAt < Date.now()) credentials=(await ctx.credentials.obtain(conn.config.authenticationSource,{format,forceAuthentication:!!opts.force})).bundle;
      req.headers.set('authorization',`Bearer ${credentials.accessToken}`);return {credentials};
    },
  };
  return {services:[{id:'fixture-authentication',name:'Authentication fixture',baseUrl:'https://fixture.invalid',authMethods:[source]},
    {id:'fixture-consumer',name:'Consumer fixture',baseUrl:(c:any)=>c.config.endpoint,allowedHosts:(c:any)=>[new URL(c.config.endpoint).host],authMethods:[consumer]}]};
}
