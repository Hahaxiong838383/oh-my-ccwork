"""Pure transforms. Nodes/credentials are injected in memory, never source literals."""
import copy

NAMES=('dmit','zgo','home')
TAGS={n:'cf-'+n for n in (*NAMES,'block')}
PORTS={'dmit':10828,'zgo':10829,'home':10830}


def client_config(base, nodes, old_tags, api_port=14991):
    c=copy.deepcopy(base)
    if c.get('api'): raise ValueError('existing API requires explicit merge review')
    if any(x.get('tag','').startswith('cf-') for x in c.get('inbounds',[])):
        raise ValueError('inbound tag conflict')
    if any(x.get('tag')=='cf-lisa' for x in c.get('routing',{}).get('balancers',[])):
        raise ValueError('balancer tag conflict')
    if any(x.get('tag','').startswith('cf-') for x in c.get('outbounds',[])):
        raise ValueError('already configured or tag conflict')
    if any(x.get('port') in (*PORTS.values(),api_port) for x in c.get('inbounds',[])):
        raise ValueError('port conflict')
    changed=0
    for r in c['routing']['rules']:
        if r.get('outboundTag') in old_tags:
            r.pop('outboundTag');r['balancerTag']='cf-lisa';changed+=1
    if not changed: raise ValueError('no Lisa rule; refusing implicit traffic scope expansion')
    for name in NAMES:
        node=copy.deepcopy(nodes[name]);node['tag']=TAGS[name];c['outbounds'].append(node)
        c['inbounds'].append({'tag':'cf-probe-'+name,'listen':'127.0.0.1','port':PORTS[name],
                             'protocol':'socks','settings':{'auth':'noauth','udp':False}})
    c['outbounds'].append({'tag':TAGS['block'],'protocol':'blackhole'})
    c['routing']['rules'][:0]=[{'type':'field','inboundTag':['cf-probe-'+n],'outboundTag':TAGS[n]} for n in NAMES]
    c['routing'].setdefault('balancers',[]).append({'tag':'cf-lisa','selector':[TAGS['block']],
                    'fallbackTag':TAGS['block'],'strategy':{'type':'random'}})
    c['api']={'tag':'cf-api','listen':'127.0.0.1:'+str(api_port),'services':['RoutingService']}
    # Xray 26.3.27's random+fallback requires observatory dependency, even block-only.
    if not c.get('observatory') and not c.get('burstObservatory'): c['observatory']={'subjectSelector':[]}
    return c,changed


def controller_config(xray, runtime):
    return {'xray':xray,'curl':'/usr/bin/curl','api':'127.0.0.1:14991','balancer':'cf-lisa',
            'ports':PORTS,'tags':TAGS,'state':runtime+'/state.json','pin':runtime+'/pin.json',
            'targets':[{'name':'https','url':'https://www.google.com/generate_204','accept':['204']},
                       {'name':'codex','url':'https://chatgpt.com/backend-api/codex/models?client_version=0.160.1','accept':['200','401']}]}


def relay_config(node, accounts, bind, allowed_sources):
    node=copy.deepcopy(node);node['tag']='relay-fixed-dmit'
    if node.get('proxySettings') or node.get('streamSettings',{}).get('sockopt',{}).get('dialerProxy'):
        raise ValueError('relay node not independent')
    return {'log':{'loglevel':'warning'},'inbounds':[{'tag':'company-relay','listen':bind,'port':10810,
            'protocol':'socks','settings':{'auth':'password','accounts':accounts,'udp':False}}],
            'outbounds':[{'tag':'block','protocol':'blackhole'},node],
            'routing':{'domainStrategy':'IPOnDemand','rules':[
                {'type':'field','domain':['geosite:private'],'outboundTag':'block'},
                {'type':'field','ip':['geoip:private'],'outboundTag':'block'},
                {'type':'field','inboundTag':['company-relay'],'source':allowed_sources,'network':'tcp','outboundTag':'relay-fixed-dmit'},
                {'type':'field','network':'tcp,udp','outboundTag':'block'}]}}
