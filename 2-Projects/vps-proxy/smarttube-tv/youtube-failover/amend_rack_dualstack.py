#!/usr/bin/env python3
"""Pure amendment of the live TV release; credentials stay in caller memory.

Do not pass the pre-failover source to this function or rebuild from old stages.
The caller verifies the live manifest and remote Reality credentials first.
"""
import copy
import ipaddress

VIDEO = ['yt-rack-hy2', 'yt-rack-reality', 'yt-zgo-reality', 'yt-zgo-hy2']
DNS = ['dns-rack-reality', 'dns-zgo-reality']
V6_VIDEO = 'yt-rack-reality-ipv6'
V6_DNS = 'dns-rack-reality-ipv6'


def amend(main, worker, guard, observe, *, old_ipv4, ipv4, ipv6, port, sni,
          selected_video, selected_dns):
    """Return four deep-copied configs, preserving all unrelated live state."""
    assert ipaddress.ip_address(old_ipv4).version == 4
    assert ipaddress.ip_address(ipv4).version == 4
    assert ipaddress.ip_address(ipv6).version == 6
    assert isinstance(port, int) and 1 <= port <= 65535
    assert isinstance(sni, str) and sni and all(c.isalnum() or c in '.-' for c in sni)
    assert selected_video in VIDEO and selected_dns in DNS
    main, worker, guard, observe = copy.deepcopy((main, worker, guard, observe))
    by_tag = {o['tag']: o for o in main['outbounds']}
    assert len(by_tag) == len(main['outbounds'])
    assert by_tag['youtube-video']['outbounds'] == VIDEO
    assert by_tag['dns-uplink']['outbounds'] == DNS
    assert by_tag['youtube-video']['interrupt_exist_connections'] is False
    assert by_tag['dns-uplink']['interrupt_exist_connections'] is True
    assert V6_VIDEO not in by_tag and V6_DNS not in by_tag
    for tag in ('reality', 'yt-rack-reality', 'dns-rack-reality'):
        o = by_tag[tag]
        assert o['type'] == 'vless' and o['server'] == old_ipv4
        assert o['tls']['reality']['enabled'] is True
        o['server'] = ipv4
        o['server_port'] = port
        o['tls']['server_name'] = sni
    # Keep HY2 settings/authentication and worker isolation; only migrate IP.
    assert by_tag['hy2']['type'] == 'hysteria2' and by_tag['hy2']['server'] == old_ipv4
    by_tag['hy2']['server'] = ipv4
    hy2 = [o for o in worker['outbounds'] if o['type'] == 'hysteria2']
    assert len(hy2) == 1 and hy2[0]['server'] == old_ipv4
    hy2[0]['server'] = ipv4
    occupied = {o.get('listen_port') for o in main['inbounds']}
    assert not occupied.intersection({19105, 19113})
    for parent, tag, probe_port in [('yt-rack-reality', V6_VIDEO, 19105),
                                    ('dns-rack-reality', V6_DNS, 19113)]:
        outbound = copy.deepcopy(by_tag[parent])
        outbound.update(tag=tag, server=ipv6)
        main['outbounds'].append(outbound)
        inbound = 'probe-' + tag
        main['inbounds'].append(dict(type='socks', tag=inbound, listen='127.0.0.1', listen_port=probe_port))
        parent_inbound = 'probe-' + parent
        rules = main['route']['rules']
        indexes = [i for i, rule in enumerate(rules) if rule.get('inbound') == [parent_inbound]]
        assert len(indexes) == 1 and rules[indexes[0]]['outbound'] == parent
        rules.insert(indexes[0] + 1, dict(inbound=[inbound], action='route', outbound=tag))
    by_tag['youtube-video']['outbounds'].insert(2, V6_VIDEO)
    by_tag['dns-uplink']['outbounds'].insert(1, V6_DNS)
    # A reload must not reset selection to a different route before the guard
    # has obtained fresh evidence. Normal recovery retains its 3/300s gate.
    by_tag['youtube-video']['default'] = selected_video
    by_tag['dns-uplink']['default'] = selected_dns
    for config in (guard, observe):
        assert [c['tag'] for c in config['candidates']] == VIDEO
        assert [c['tag'] for c in config['dns']['candidates']] == DNS
        config['candidates'].insert(2, dict(tag=V6_VIDEO, socks_port=19105))
        config['dns']['candidates'].insert(1, dict(tag=V6_DNS, socks_port=19113))
    return main, worker, guard, observe
