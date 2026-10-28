"""Conservative Xray routing audit/planning. Pure functions; no network or file IO.

Only proven coverage is simplified. Unknown matchers are retained. Different
fields are AND, entries within one field are OR, and the first matching rule wins.
"""
import copy
import hashlib
import ipaddress
import json
import re

PROTECTED_GROUPS = frozenset(('cf-lisa',))
SAFE_FALLBACK_PROTOCOLS = frozenset(('vless','vmess','socks','http','shadowsocks','trojan','wireguard','blackhole'))
CHATGPT_DOMAINS = ('domain:chatgpt.com',)
CHATGPT_RULE_TAG = 'managed-chatgpt-domain-route-v1'
DOMAIN_PROXY_PROTOCOLS = SAFE_FALLBACK_PROTOCOLS - {'blackhole'}
MATCH_FIELDS = frozenset(('domain','ip','inboundTag','source','sourcePort','port','network','protocol','user'))
META_FIELDS = frozenset(('type','outboundTag','balancerTag','ruleTag','tag'))

class PolicyError(ValueError):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(code)


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()


def _sections(config):
    if not isinstance(config,dict) or not isinstance(config.get('routing'),dict):
        raise PolicyError('invalid_config','配置缺少有效路由段。')
    routing=config['routing'];rules=routing.get('rules',[]);groups=routing.get('balancers',[]);nodes=config.get('outbounds',[])
    if any(not isinstance(x,list) or any(not isinstance(y,dict) for y in x) for x in (rules,groups,nodes)):
        raise PolicyError('invalid_config','规则、均衡组或节点格式不正确。')
    if any(not isinstance(x.get('tag'),str) or not x['tag'] for x in groups+nodes):
        raise PolicyError('invalid_tag','节点或均衡组标签必须是非空字符串。')
    inbounds=config.get('inbounds',[])
    if not isinstance(inbounds,list) or any(not isinstance(x,dict) for x in inbounds):
        raise PolicyError('invalid_config','入站列表格式不正确。')
    return rules,groups,nodes


def _meta(metadata):
    if metadata is None: return {'version':1,'disabled':{}}
    if (not isinstance(metadata,dict) or type(metadata.get('version')) is not int or metadata['version']!=1
            or not isinstance(metadata.get('disabled'),dict)):
        raise PolicyError('invalid_metadata','启停记录损坏或版本不支持；禁止覆盖。')
    return copy.deepcopy(metadata)


def _target(rule):
    return ('balancer',rule['balancerTag']) if rule.get('balancerTag') else ('outbound',rule.get('outboundTag'))


def _protected(rule, config):
    inbound=rule.get('inboundTag',[])
    if not isinstance(inbound,list):return True
    api_tag=config.get('api',{}).get('tag','api') if isinstance(config.get('api',{}),dict) else 'api'
    return any(isinstance(t,str) and (t.startswith('cf-probe-') or t in ('cf-api',api_tag)) for t in inbound) or rule.get('outboundTag') in ('api','cf-api',api_tag)


def _domain(value):
    if not isinstance(value,str):return None
    match=re.fullmatch(r'(domain|full):([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?)+',value)
    if not match:return None
    kind,host=value.split(':',1)
    # A final dot is meaningful to some matchers; do not silently normalize it.
    return kind,host


def _covers(field, earlier, later):
    if earlier==later:return True
    if field=='domain':
        a,b=_domain(earlier),_domain(later)
        return bool(a and b and a[0]=='domain' and (b[1]==a[1] or b[1].endswith('.'+a[1])))
    if field in ('ip','source'):
        try:
            a,b=ipaddress.ip_network(earlier,strict=False),ipaddress.ip_network(later,strict=False)
            return a.version==b.version and b.subnet_of(a)
        except (ValueError,TypeError):return False
    return False


def _field_covers(field, a, b):
    if a==b:return True
    if field in ('domain','ip','source','inboundTag','protocol','user'):
        return isinstance(a,list) and isinstance(b,list) and bool(a) and bool(b) and all(any(_covers(field,x,y) for x in a) for y in b)
    if field=='network' and isinstance(a,str) and isinstance(b,str):
        return set(b.split(','))<=set(a.split(','))
    # Ports, regex attributes and unknown fields are not widened by guessing.
    return False


def _rule_covers(a,b,omit=None):
    if set(a)-MATCH_FIELDS-META_FIELDS or set(b)-MATCH_FIELDS-META_FIELDS:return False
    if a.get('type','field')!='field' or b.get('type','field')!='field':return False
    for key in MATCH_FIELDS:
        if key==omit:continue
        if key in a and (key not in b or not _field_covers(key,a[key],b[key])):return False
    return True


def _covered_term(earlier, later, field, term):
    return (isinstance(earlier.get(field),list) and _rule_covers(earlier,later,omit=field)
            and any(_covers(field,x,term) for x in earlier[field]))


def _reduce(field, values):
    kept=[]
    for value in values:
        if any(_covers(field,x,value) for x in kept):continue
        kept=[x for x in kept if not _covers(field,value,x)]
        kept.append(value)
    return kept


def _metadata_check(config, metadata):
    rules,groups,_=_sections(config);by_tag={g.get('tag'):g for g in groups}
    for tag,entry in metadata['disabled'].items():
        if tag in PROTECTED_GROUPS or tag not in by_tag or not isinstance(entry,dict):
            raise PolicyError('metadata_drift','启停记录与现有均衡组不一致。')
        if entry.get('balancer_sha256')!=digest(by_tag[tag]) or not isinstance(entry.get('rules'),list):
            raise PolicyError('metadata_drift','均衡组自停用后已变化，请先核对恢复记录。')
        if (type(entry.get('rule_count')) is not int or entry['rule_count']!=len(entry['rules'])
                or entry.get('rules_sha256')!=digest(entry['rules'])):
            raise PolicyError('metadata_drift','关联规则恢复记录不完整，请先核对备份。')
        seen=set()
        for saved in entry['rules']:
            if not isinstance(saved,dict):raise PolicyError('metadata_drift','恢复记录格式不正确。')
            index=saved.get('index');original=saved.get('original');disabled=saved.get('disabled')
            if (type(index) is not int or index<0 or index>=len(rules) or index in seen
                    or not isinstance(original,dict) or not isinstance(disabled,dict)
                    or original.get('balancerTag')!=tag or 'outboundTag' in original):
                raise PolicyError('metadata_drift','关联规则位置或恢复记录不一致。')
            expected=copy.deepcopy(original);expected.pop('balancerTag');expected['outboundTag']=entry.get('fallback')
            if disabled!=expected or rules[index]!=disabled:
                raise PolicyError('metadata_drift','停用后的规则已变化，不能直接恢复覆盖。')
            seen.add(index)
        if any(r.get('balancerTag')==tag for r in rules):
            raise PolicyError('metadata_drift','停用组出现新的关联规则，请先核对。')
    _domain_metadata_check(config,metadata)


def _domain_outbounds(config):
    """Static eligible proxies only; this does not attest location or reachability."""
    rules,groups,nodes=_sections(config)
    protected={r.get('outboundTag') for r in rules if _protected(r,config)}
    managed=[g for g in groups if g.get('tag') in PROTECTED_GROUPS]
    result=[]
    for node in nodes:
        tag=node['tag']
        if (tag.startswith('cf-') or tag in protected or node.get('protocol') not in DOMAIN_PROXY_PROTOCOLS
                or sum(n.get('tag')==tag for n in nodes)!=1):continue
        if any(tag==g.get('fallbackTag') or (isinstance(g.get('selector'),list)
                and any(isinstance(s,str) and tag.startswith(s) for s in g['selector'])) for g in managed):continue
        proxy=node.get('proxySettings',{});stream=node.get('streamSettings',{})
        if not isinstance(proxy,dict) or proxy.get('tag') or not isinstance(stream,dict):continue
        sockopt=stream.get('sockopt',{})
        if not isinstance(sockopt,dict) or sockopt.get('dialerProxy'):continue
        result.append(node)
    return result


def _chatgpt_rule(outbound):
    return {'type':'field','ruleTag':CHATGPT_RULE_TAG,'domain':list(CHATGPT_DOMAINS),'outboundTag':outbound}


def _protected_rules(config):
    return [(i,r) for i,r in enumerate(config['routing'].get('rules',[])) if _protected(r,config)]


def _domain_metadata_check(config,metadata):
    rules,_,_=_sections(config);records=metadata.get('domain_routes',{})
    marked=[i for i,r in enumerate(rules) if r.get('ruleTag')==CHATGPT_RULE_TAG]
    if not isinstance(records,dict) or set(records)-{'chatgpt'}:
        raise PolicyError('metadata_drift','域名定向记录不明确，禁止覆盖。')
    entry=records.get('chatgpt')
    if entry is None:
        if records or marked:raise PolicyError('metadata_drift','存在未关联的域名定向标记，请先核对恢复记录。')
        return
    fields={'version','index','outbound','rule_sha256','outbound_sha256','other_rules_sha256','protected_sha256'}
    if not isinstance(entry,dict) or set(entry)!=fields or type(entry.get('version')) is not int or entry['version']!=1:
        raise PolicyError('metadata_drift','域名定向恢复记录损坏。')
    index=entry['index'];outbound=entry['outbound']
    if type(index) is not int or index<0 or index>=len(rules) or marked!=[index] or not isinstance(outbound,str):
        raise PolicyError('metadata_drift','域名定向规则位置或唯一标记已变化。')
    node=next((n for n in _domain_outbounds(config) if n['tag']==outbound),None)
    if (rules[index]!=_chatgpt_rule(outbound) or entry['rule_sha256']!=digest(rules[index])
            or node is None or entry['outbound_sha256']!=digest(node)
            or entry['other_rules_sha256']!=digest(rules[:index]+rules[index+1:])
            or entry['protected_sha256']!=digest(_protected_rules(config))):
        raise PolicyError('metadata_drift','域名定向或原有规则已在外部变化，不能直接覆盖或撤销。')


def chatgpt_route_state(config,metadata=None):
    meta=_meta(metadata);_metadata_check(config,meta)
    entry=meta.get('domain_routes',{}).get('chatgpt')
    return {'enabled':entry is not None,'outbound':entry['outbound'] if entry else None,
            'domains':list(CHATGPT_DOMAINS),'rule_indices':[entry['index']] if entry else [],
            'outbounds':[{'tag':n['tag'],'protocol':n['protocol']} for n in _domain_outbounds(config)]}


def _may_match_chatgpt(rule):
    # Unknown/opaque domains may overlap. Other fields can restrict traffic but
    # cannot prove that no ChatGPT request will match this preceding rule.
    domains=rule.get('domain')
    if not isinstance(domains,list) or not domains:return True
    for value in domains:
        parsed=_domain(value)
        if parsed is None:return True
        if any(_covers('domain',value,target) or _covers('domain',target,value) for target in CHATGPT_DOMAINS):return True
    return False


def _plan_domain_route(config,meta,request):
    enabled=request.get('enabled')
    if type(enabled) is not bool or set(request)!=({'action','enabled','outbound'} if enabled else {'action','enabled'}):
        raise PolicyError('invalid_request','仅支持预定义 ChatGPT 域名组及明确的启停、代理节点。')
    rules=config['routing']['rules'];entry=meta.get('domain_routes',{}).get('chatgpt')
    if not enabled:
        if entry is None:return []
        if meta['disabled']:raise PolicyError('disabled_groups','请先恢复已停用均衡组，再撤销定向规则，以保持恢复索引。')
        index=entry['index'];rules.pop(index);meta.pop('domain_routes',None)
        return [{'kind':'remove_domain_route','rule':index,'message':'撤销 ChatGPT 专用定向规则；原有规则、条件和顺序完整恢复。'}]
    outbound=request.get('outbound')
    node=next((n for n in _domain_outbounds(config) if isinstance(outbound,str) and n['tag']==outbound),None)
    if node is None:raise PolicyError('invalid_domain_outbound','必须选择现有、非受管且无代理链依赖的代理节点；不允许直连或阻断出口。')
    if entry and entry['outbound']==outbound:return []
    if entry:
        index=entry['index'];rules[index]=_chatgpt_rule(outbound);kind='replace_domain_route'
    else:
        if meta['disabled']:raise PolicyError('disabled_groups','请先恢复已停用均衡组，再新增定向规则，以保持恢复索引。')
        index=max((i for i,_ in _protected_rules(config)),default=-1)+1
        if any(not _protected(r,config) and _may_match_chatgpt(r) for r in rules[:index]):
            raise PolicyError('unsafe_domain_position','前序目标或不透明规则与控制规则交错，不能在保持控制规则位置的同时保证定向优先。')
        rules.insert(index,_chatgpt_rule(outbound));kind='insert_domain_route'
    meta['domain_routes']={'chatgpt':{'version':1,'index':index,'outbound':outbound,
        'rule_sha256':digest(rules[index]),'outbound_sha256':digest(node),
        'other_rules_sha256':digest(rules[:index]+rules[index+1:]),'protected_sha256':digest(_protected_rules(config))}}
    return [{'kind':kind,'rule':index,'message':'ChatGPT 预定义域名定向至 {}；保留原有规则，可单独撤销。此为配置目标，未声称出口位置或实时可达。'.format(outbound)}]


def group_states(config, metadata=None):
    rules,groups,nodes=_sections(config);meta=_meta(metadata);_metadata_check(config,meta)
    result=[]
    for group in groups:
        tag=group.get('tag','');entry=meta['disabled'].get(tag)
        selector=group.get('selector',[])
        result.append({'tag':tag,'enabled':entry is None,'protected':tag in PROTECTED_GROUPS,
            'rule_indices':[x['index'] for x in entry['rules']] if entry else [i for i,r in enumerate(rules) if r.get('balancerTag')==tag],
            'fallback':entry.get('fallback') if entry else group.get('fallbackTag'),
            'nodeTags':[n.get('tag') for n in nodes if isinstance(n.get('tag'),str) and isinstance(selector,list)
                        and any(isinstance(s,str) and n['tag'].startswith(s) for s in selector)],
            'strategy':group.get('strategy',{}).get('type','random') if isinstance(group.get('strategy',{}),dict) else 'unknown'})
    return result


def audit_config(config, metadata=None):
    issues=[]
    def add(severity,code,message,rules=None,balancer=None):
        item={'severity':severity,'code':code,'message':message,'rules':rules or []}
        if balancer is not None:item['balancer']=balancer
        issues.append(item)
    try:rules,groups,nodes=_sections(config)
    except PolicyError as e:return {'issues':[{'severity':'error','code':e.code,'message':e.message,'rules':[]}],'counts':{'error':1,'warning':0,'info':0,'rules':0,'balancers':0}}
    try:_metadata_check(config,_meta(metadata))
    except PolicyError as e:add('error',e.code,e.message)
    node_tags=[n.get('tag') for n in nodes];group_tags=[g.get('tag') for g in groups]
    for label,tags in [('节点',node_tags),('均衡组',group_tags)]:
        if any(not isinstance(t,str) or not t for t in tags):add('error','invalid_tag',label+'存在空或无效标签。')
        valid=[t for t in tags if isinstance(t,str)]
        if len(valid)!=len(set(valid)):add('error','duplicate_tag',label+'标签重复，引用不唯一。')
    api_tag=config.get('api',{}).get('tag') if isinstance(config.get('api'),dict) else None
    inbound_tags={x.get('tag') for x in config.get('inbounds',[]) if isinstance(x,dict) and isinstance(x.get('tag'),str)}
    for index,rule in enumerate(rules):
        targets=[k for k in ('outboundTag','balancerTag') if rule.get(k)]
        if len(targets)!=1:add('error','ambiguous_target','规则必须且只能指定一个节点或均衡组目标。',[index])
        else:
            key=targets[0];tag=rule[key]
            if not isinstance(tag,str) or (tag not in (node_tags if key=='outboundTag' else group_tags) and not (key=='outboundTag' and tag==api_tag)):
                add('error','missing_target','规则引用的目标不存在。',[index])
        if not (set(rule)&MATCH_FIELDS):add('error','missing_condition','规则没有匹配条件；请显式指定匹配范围。',[index])
        if rule.get('domain') and rule.get('ip'):add('warning','domain_ip_and','域名与 IP 同条是 AND，必须同时满足。',[index])
        for key in ('domain','ip','source','inboundTag','protocol','user'):
            if key not in rule:continue
            values=rule[key]
            if not isinstance(values,list) or not values or any(not isinstance(x,str) or not x for x in values):
                add('error','invalid_matcher','匹配条件必须为非空字符串列表。',[index]);continue
            if key=='inboundTag' and any(x not in inbound_tags for x in values):add('warning','missing_inbound','规则引用的入站不存在。',[index])
            if key in ('domain','ip','source') and len(_reduce(key,values))<len(values):add('info','redundant_condition','同条规则中存在重复或已被宽条件包含的项目。',[index])
            if key=='domain':
                if any(x.startswith(('domain:','full:')) and not _domain(x) for x in values):add('warning','invalid_domain','域名格式异常（例如路径或尾斜杠）；保留原值，请核对意图。',[index])
                if any(x.startswith(('regexp:','geosite:','ext:')) for x in values):add('warning','opaque_matcher','正则或资源库的交集未穷举；检测结果不等于全量无冲突。',[index])
            if key=='ip' and any(x.startswith(('geoip:','ext:')) for x in values):add('info','opaque_matcher','地理 IP 库未展开，保留其顺序并由 Xray 校验。',[index])
        for earlier_index,earlier in enumerate(rules[:index]):
            if _protected(earlier,config) or _protected(rule,config):continue
            for field in ('domain','ip'):
                values=rule.get(field)
                if not isinstance(values,list):continue
                covered=[x for x in values if isinstance(x,str) and _covered_term(earlier,rule,field,x)]
                if covered:
                    different=_target(earlier)!=_target(rule)
                    add('warning' if different else 'info','shadowed_condition',
                        '{} 个条件被前面的规则覆盖{}。'.format(len(covered),'，当前以前面的不同目标为准' if different else '，目标相同'),[earlier_index,index])
            if _rule_covers(earlier,rule) and not (set(earlier)-META_FIELDS)==set():
                add('warning' if _target(earlier)!=_target(rule) else 'info','shadowed_rule','整条规则已被前面的条件覆盖。',[earlier_index,index]);break
    for group in groups:
        tag=group.get('tag','');selectors=group.get('selector',[])
        if not isinstance(selectors,list) or not selectors or any(not isinstance(s,str) or not s for s in selectors):
            add('error','empty_selector','均衡组 selector 为空或无效。',balancer=tag);continue
        matched=[t for t in node_tags if isinstance(t,str) and any(t.startswith(s) for s in selectors)]
        if not matched:add('error','empty_selector','均衡组没有匹配到节点。',balancer=tag)
        if any(sum(t.startswith(s) for s in selectors)>1 for t in matched):add('warning','overlapping_selectors','多个 selector 前缀命中同一节点，请核对候选范围。',balancer=tag)
        if group.get('fallbackTag') and group['fallbackTag'] not in node_tags:add('error','missing_fallback','备用节点不存在。',balancer=tag)
    # Existing proxy chains can form cycles even when routing targets exist.
    links={}
    for node in nodes:
        settings=node.get('proxySettings',{})
        if isinstance(settings,dict) and isinstance(node.get('tag'),str) and settings.get('tag'):
            links[node['tag']]=settings['tag']
            if settings['tag'] not in node_tags:add('error','missing_chain_target','节点引用的代理链目标不存在。')
    for start in links:
        seen=set();cursor=start
        while isinstance(cursor,str) and cursor in links:
            if cursor in seen:add('error','proxy_cycle','代理链存在循环引用。');break
            seen.add(cursor);cursor=links[cursor]
    return {'issues':issues,'counts':{**{s:sum(i['severity']==s for i in issues) for s in ('error','warning','info')},'rules':len(rules),'balancers':len(groups)}}


def _normalize(config):
    result=copy.deepcopy(config);rules=result['routing']['rules'];kept=[];changes=[]
    for index,original in enumerate(rules):
        rule=copy.deepcopy(original)
        if _protected(rule,config) or rule.get('ruleTag') or set(rule)-MATCH_FIELDS-META_FIELDS:
            kept.append(rule);continue
        remove=False
        for field in ('domain','ip'):
            values=rule.get(field)
            if not isinstance(values,list) or not values or any(not isinstance(v,str) for v in values):continue
            compact=_reduce(field,values)
            if compact!=values:changes.append({'kind':'deduplicate','rule':index,'message':'规则 {} 去除 {} 个重复/被包含的 {} 条件。'.format(index+1,len(values)-len(compact),field)})
            remaining=[x for x in compact if not any(not _protected(e,config) and _covered_term(e,rule,field,x) for e in kept)]
            if remaining!=compact:changes.append({'kind':'remove_shadowed','rule':index,'message':'规则 {} 移除 {} 个已被前序规则覆盖的 {} 条件，保留当前实际优先顺序。'.format(index+1,len(compact)-len(remaining),field)})
            if not remaining:remove=True;break
            rule[field]=remaining
        if not remove and any(not _protected(e,config) and _rule_covers(e,rule) for e in kept):
            remove=True
        if remove:changes.append({'kind':'remove_rule','rule':index,'message':'移除规则 {}：其匹配范围已全部由前序规则处理。'.format(index+1)})
        else:kept.append(rule)
    result['routing']['rules']=kept
    return result,changes


def plan_change(config, metadata, request):
    rules,groups,nodes=_sections(config);meta=_meta(metadata);_metadata_check(config,meta)
    if not isinstance(request,dict):raise PolicyError('invalid_request','请求格式不正确。')
    initial=audit_config(config,meta)
    if initial['counts']['error']:raise PolicyError('config_conflict','存在阻断级配置冲突，请先修复引用或格式。')
    action=request.get('action');candidate=copy.deepcopy(config);changes=[]
    if action=='normalize':
        if meta['disabled']:raise PolicyError('disabled_groups','请先启用已停用均衡组，再整理规则，以保留准确恢复位置。')
        if meta.get('domain_routes'):raise PolicyError('domain_route_active','请先撤销 ChatGPT 定向规则，再整理原规则，以保留准确恢复语义。')
        candidate,changes=_normalize(config)
    elif action=='toggle':
        tag=request.get('tag');enabled=request.get('enabled')
        if not isinstance(tag,str) or type(enabled) is not bool:raise PolicyError('invalid_request','均衡组标签与启用状态无效。')
        group=next((g for g in groups if g.get('tag')==tag),None)
        if group is None:raise PolicyError('unknown_group','均衡组不存在。')
        if tag in PROTECTED_GROUPS:raise PolicyError('protected_group','该均衡组由自动切换控制器管理，不能在此停用。')
        disabled=meta['disabled'].get(tag)
        if enabled and disabled:
            for saved in disabled['rules']:
                candidate['routing']['rules'][saved['index']]=copy.deepcopy(saved['original'])
                changes.append({'kind':'restore_rule','rule':saved['index'],'message':'规则 {} 恢复使用均衡组 {}，条件及位置保持。'.format(saved['index']+1,tag)})
            del meta['disabled'][tag]
        elif not enabled and disabled is None:
            fallback=request.get('fallback');node=next((n for n in nodes if n.get('tag')==fallback),None)
            if not isinstance(fallback,str) or not node or node.get('protocol') not in SAFE_FALLBACK_PROTOCOLS:
                raise PolicyError('invalid_fallback','停用必须指定现有备用代理节点或阻断出口；不隐式转直连。')
            entry={'fallback':fallback,'balancer_sha256':digest(group),'rules':[]}
            for index,rule in enumerate(rules):
                if rule.get('balancerTag')!=tag:continue
                if _protected(rule,config):raise PolicyError('protected_rule','该组被基础控制规则引用，不能普通停用。')
                changed=copy.deepcopy(rule);changed.pop('balancerTag');changed['outboundTag']=fallback
                candidate['routing']['rules'][index]=changed
                entry['rules'].append({'index':index,'original':copy.deepcopy(rule),'disabled':copy.deepcopy(changed)})
                changes.append({'kind':'fallback_rule','rule':index,'message':'规则 {} 从均衡组 {} 转交显式备用 {}；匹配条件和位置保持。'.format(index+1,tag,fallback)})
            entry.update(rule_count=len(entry['rules']),rules_sha256=digest(entry['rules']))
            meta['disabled'][tag]=entry
        if meta!=_meta(metadata) and not changes:changes.append({'kind':'group_state','message':'更新无关联规则的均衡组状态。'})
        # Toggle only changes rule targets, never count/order. Accept only this
        # authorized update to the other-rule fingerprint, so external drift
        # remains blocked while normal group enable/disable keeps working.
        entry=meta.get('domain_routes',{}).get('chatgpt')
        if entry:
            current=candidate['routing']['rules'];index=entry['index']
            entry['other_rules_sha256']=digest(current[:index]+current[index+1:])
    elif action=='domain_route':
        changes=_plan_domain_route(candidate,meta,request)
        if _protected_rules(config)!=_protected_rules(candidate):
            raise PolicyError('protected_rule','基础控制规则及索引必须完全保持。')
    else:raise PolicyError('unknown_action','不支持的路由操作。')
    audit=audit_config(candidate,meta)
    if audit['counts']['error']:raise PolicyError('candidate_conflict','候选配置存在阻断级冲突。')
    return {'config':candidate,'metadata':meta,'changes':changes,'audit':audit}
