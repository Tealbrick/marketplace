#!/usr/bin/env python3
"""Builds the Chatwoot overlay (the real routes missing from the upstream swagger, x-source: code).

usage: gen-overlay.py ROUTES_JSON SWAGGER_JSON CONTROLLERS_DIR OUT_OVERLAY [--stats]

ROUTES_JSON    flat routes from expand-routes.rb (enterprise conditionals off)
SWAGGER_JSON   the vendored upstream swagger (../openapi.json)
CONTROLLERS_DIR  inputs/controllers: controller sources at the pinned tag; a candidate
                 file that is absent here does not exist upstream
Deterministic: same inputs, same bytes. Relative paths only.
"""
import json,re,os,sys
routes_json,swagger_json,ctrl_dir,out_path=sys.argv[1:5]
stats='--stats' in sys.argv
M=('get','post','put','patch','delete')
def norm(p): return re.sub(r'\{[^}]+\}|:[a-z_]+','{}',p)

sw=json.load(open(swagger_json))
swpaths={}
swids=set()
for p,v in sw['paths'].items():
    swpaths[norm(p)]=p
    for m,o in v.items():
        if m in M: swids.add(o['operationId'])
swops={(m.upper(),norm(p)) for p,v in sw['paths'].items() for m in v if m in M}

# 1. routes that the swagger lacks
api=[x for x in json.load(open(routes_json)) if x['path'].startswith(('/api/v1','/api/v2','/platform/api','/public/api'))]
rt={}
for x in api: rt[(x['verb'],norm(x['path']))]=x
rows=[x for k,x in rt.items() if k not in swops]
if stats:
    print('routes',len(rt),'swagger',len(swops),'in both',len([k for k in rt if k in swops]),'missing from swagger',len(rows),file=sys.stderr)
    for k in sorted(swops):
        if k not in rt: print('  swagger op without a route:',k,file=sys.stderr)

# 2. keep a route only when the controller defines the action
def read(path):
    f=os.path.join(ctrl_dir,path)
    return open(f).read() if os.path.exists(f) else None
def cands(x):
    mods='/'.join(x['modules']); c=x['controller']
    if c is None: return []
    stem=f"{mods}/{c}_controller.rb" if mods else f"{c}_controller.rb"
    singular=c[:-1] if c.endswith('s') else c
    out=[f"app/controllers/{stem}",f"enterprise/app/controllers/{stem}",f"enterprise/app/controllers/enterprise/{stem}"]
    if c.endswith('s'):
        s2=stem.replace(f"{c}_controller.rb",f"{singular}_controller.rb")
        out+= [f"app/controllers/{s2}",f"enterprise/app/controllers/{s2}",f"enterprise/app/controllers/enterprise/{s2}"]
    if stem.endswith('accounts/inboxes_controller.rb'):
        out+=['app/controllers/api/v1/accounts/concerns/inbox_health_management.rb','app/controllers/api/v1/accounts/concerns/inbox_secret_management.rb']
    return out
if '--list-candidates' in sys.argv:
    for p in sorted({p for x in rows for p in cands(x)}): print(p)
    sys.exit(0)
for x in rows:
    files=[(p,read(p)) for p in cands(x)]
    files=[(p,t) for p,t in files if t]
    x['files']=[p for p,_ in files]
    x['found']=[p for p,t in files if re.search(r'\bdef\s+'+re.escape(x['action'])+r'\b',t)]
    x['texts']=[t for _,t in files]

skipped={'phantom':[], 'widget':[], 'client-session':[], 'alias':[], 'get-alias-of-mutation':[]}
keep=[]
for x in rows:
    p=x['path']; v=x['verb']
    if not x['found']: skipped['phantom'].append(x); continue
    if p.startswith('/api/v1/widget/'): skipped['widget'].append(x); continue
    if p in ('/api/v1/auth/saml_login','/api/v1/notification_subscriptions','/api/v1/integrations/webhooks'): skipped['client-session'].append(x); continue
    if v=='GET' and p.endswith('/callbacks/register_facebook_page'): skipped['get-alias-of-mutation'].append(x); continue
    if v=='PATCH' and ('PUT',norm(p)) in swops: skipped['alias'].append(x); continue
    keep.append(x)
if stats: print({k:len(v) for k,v in skipped.items()}, 'keep',len(keep),file=sys.stderr)

def src_files(x): return x['texts']
SKIP={'id','account_id','format','controller','action','locale'}
def param_names(texts):
    names=set()
    for t in texts:
        names|=set(re.findall(r'params\[:(\w+)\]',t))
        for dig in re.findall(r'params\.dig\(([^)]*)\)',t): names|=set(re.findall(r':(\w+)',dig))
        for m in re.finditer(r'permit\(',t):
            i=m.end(); depth=1; j=i
            while j<len(t) and depth: 
                depth+= t[j]=='('; depth-= t[j]==')'; j+=1
            seg=t[i:j-1]
            names|=set(re.findall(r':(\w+)',seg))|set(re.findall(r'\b(\w+):',seg))
    return sorted(n for n in names if n not in SKIP and not n.endswith('_id') or n in ('inbox_id','team_id','user_ids') )

TAGMAP={'contacts':'Contacts','conversations':'Conversations','inboxes':'Inboxes','teams':'Teams','agents':'Agents','agent_bots':'Account AgentBots','portals':'Help Center','integrations':'Integrations','automation_rules':'Automation Rule','canned_responses':'Canned Responses','webhooks':'Webhooks','campaigns':'Campaigns','labels':'Labels','custom_attribute_definitions':'Custom Attributes','custom_filters':'Custom Filters','profile':'Profile','reports':'Reports','summary_reports':'Reports','audit_logs':'Audit Logs'}
def title(s): return ' '.join(w.capitalize() for w in s.split('_'))
def segs(path):
    s=path
    for pre in ('/api/v1/accounts/:account_id/','/api/v2/accounts/:account_id/','/platform/api/v1/','/public/api/v1/','/api/v1/','/api/v2/'):
        if s.startswith(pre): return s[len(pre):].split('/'),pre
    return s.strip('/').split('/'),''
def tag_for(x):
    s,pre=segs(x['path'])
    first=s[0] if s else 'general'
    if pre.startswith('/platform'): return {'users':'Users','agent_bots':'AgentBots','accounts':'Accounts'}.get(first,'Platform '+title(first))
    if pre.startswith('/public'): return 'Public '+title(first)
    return TAGMAP.get(first,title(first))
def verb_word(v): return v.lower()
ids={}
def op_id(x):
    s,pre=segs(x['path'])
    parts=[re.sub(r'[^a-z0-9]+','-',seg.lower()) for seg in s if not seg.startswith(':')]
    act=x['action']
    if act in ('index','show','create','update','destroy'): base=parts+[act]
    else:
        base=parts+[] if parts and parts[-1].replace('-','_')==act else parts+[act.replace('_','-')]
        if act=='retry_import': base=parts+['retry-import']
    pfx='platform-' if pre.startswith('/platform') else 'public-' if pre.startswith('/public') else 'v2-' if pre.startswith('/api/v2') else ''
    if pre=='/api/v1/' : pfx='v1-'
    # singular resource actions (show/create/update/destroy) on member routes use path params so keep action
    oid=pfx+'-'.join(b for b in base if b)
    oid=re.sub(r'-+','-',oid)
    return oid
used=set()
paths={}
out_ops=[]
for x in keep:
    oid=op_id(x)
    if oid in used or oid in swids: oid=oid+'-'+x['verb'].lower()
    assert oid not in used and oid not in swids,(oid,x['path'])
    used.add(oid)
    p=x['path']
    tpl=re.sub(r':([a-z_]+)',r'{\1}',p)
    key=swpaths.get(norm(p),tpl)
    texts=src_files(x)
    names=param_names(texts)
    op={
        'operationId':oid,
        'summary':f"{title(x['action'])} {title(x['controller'])}".strip() if x['action'] not in('index','show','create','update','destroy') else {'index':'List','show':'Get','create':'Create','update':'Update','destroy':'Delete'}[x['action']]+' '+title(x['controller']),
        'description':'Not in the upstream swagger. Derived from config/routes.rb and the controller at tag v4.18.0 (x-source: code); request fields are the names the controller reads and are not verified per action.' + (' Enterprise controller: needs an Enterprise-enabled installation.' if all(f.startswith('enterprise') for f in x['found']) else ''),
        'tags':[tag_for(x)],
        'x-source':'code',
        'x-code-route':f"{x['verb']} {p} -> {'/'.join(x['modules'])}/{x['controller']}#{x['action']}",
    }
    if all(f.startswith('enterprise') for f in x['found']): op['x-edition']='enterprise'
    if x['verb']=='GET':
        if names or x['action']=='index':
            q=[]
            for n in names:
                q.append({'name':n,'in':'query','required':False,'schema':{'type':['string','number','boolean']}})
            if x['action'] in('index',) and 'page' not in names:
                q.insert(0,{'name':'page','in':'query','required':False,'schema':{'type':['string','number']}})
            op['parameters']=q
    else:
        props={n:{'description':'Field read by the controller; type not verified.'} for n in names}
        op['requestBody']={'required':False,'content':{'application/json':{'schema':{'type':'object','additionalProperties':True,**({'properties':props} if props else {})}}}}
    op['responses']={'200':{'description':'Success'}}
    if tpl!=key: pass
    paths.setdefault(key,{})[x['verb'].lower()]=op
    out_ops.append((x['verb'],key,oid))
overlay={'paths':paths}
with open(out_path,'w') as fh:
    json.dump(overlay,fh,indent=1)
    fh.write('\n')
if stats: print('added',len(out_ops),'paths',len(paths),file=sys.stderr)
