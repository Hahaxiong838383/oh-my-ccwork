(function (global) {
  'use strict';

  // System WebViews shipped with Android 11 predate these two DOM/JS methods.
  if (!Element.prototype.replaceChildren) {
    Object.defineProperty(Element.prototype, 'replaceChildren', {configurable:true, writable:true,
      value:function (...nodes) { this.textContent = ''; this.append(...nodes); }});
  }
  if (!Object.hasOwn) Object.defineProperty(Object, 'hasOwn', {configurable:true, writable:true,
    value:(obj,key) => Object.prototype.hasOwnProperty.call(obj,key)});

  const storageKey = 'xiaoke.night.appearance.v1';
  const families = new Map();
  const familyNames = {classic:'暗夜球', open:'趣物偶', boop:'碰碰脸', robot:'机器头'};
  const credits = {classic:'', open:'Dominik Scholz', boop:'CX ArtLab', robot:'Fayaz Ahmed'};
  const boopSeries = {
    '1':'彩色玻璃', '2':'淡彩玻璃', '3':'软糖', '4':'糖果玻璃', '5':'亚克力', '6':'果冻',
    '7':'渐变', '8':'磨砂玻璃', '9':'磨砂金属', '10':'宝石与陶瓷', '11':'木质', '12':'球类',
    '13':'透明与流光', '14':'织物与皮革', '15':'甜点与水果', '16':'自然', '17':'图案与科技'
  };
  const openShapes = {
    controller:'游戏手柄', barbell:'杠铃', mug:'马克杯', lightbulb:'灯泡', chat:'对话气泡',
    sprout:'嫩芽', 'watering-can':'洒水壶', book:'书本', brain:'大脑', bull:'公牛',
    bunny:'小兔', camera:'相机', cat:'小猫', cloud:'云朵', egg:'小蛋', ghost:'小幽灵',
    magnifier:'放大镜', 'paint-brush':'画笔', palette:'调色盘', rocket:'火箭',
    shield:'盾牌', star:'星星', 'witch-hat':'女巫帽'
  };
  const openMaterials = {fluffy:'绒面', glass:'玻璃', flat:'平涂'};
  const openExpressions = {
    idle:'待机', happy:'开心', thinking:'思考', working:'专注', waiting:'等待', blocked:'受阻',
    done:'完成', listening:'聆听', speaking:'说话', muted:'静音', curious:'好奇', shy:'害羞'
  };
  const robotVariants = {rectangle:'经典电视', 'tv-tomato':'番茄红电视'};
  const boopVariants = {
    'classic-3d':'经典黑·立体', 'classic-2d':'经典黑·平面',
    'skin-703':'渐变黄', 'skin-704':'渐变柔紫', 'skin-1201':'沟槽足球', 'skin-1411':'深红苏格兰格'
  };
  const classicLabels = {
    sleeping:'熟睡', waking:'醒来', idle:'自在', listening:'聆听', thinking:'思考',
    searching:'寻找', working:'专注', excited:'兴奋', surprised:'惊喜', suspicious:'怀疑',
    angry:'生气', drowsy:'困倦', happy:'开心', curious:'好奇', confused:'困惑', bored:'无聊',
    proud:'得意', shy:'害羞', sad:'难过', laughing:'大笑', scared:'害怕', playful:'俏皮',
    alerting:'警觉', receiving:'接收', sending:'传达', loading:'加载', spawning:'登场',
    humming:'哼唱', writing:'书写', dictating:'讲述', radar:'探测', celebrate:'庆祝',
    orbit:'环绕', progress:'推进', uploading:'上传', notifying:'提醒', dragging:'拖动',
    bouncing:'弹跳', 'powering-down':'休眠'
  };

  function variantLabel(familyId, variant) {
    if (familyId === 'open') {
      const parts = String(variant.id || '').split(':');
      const shape = openShapes[parts[0]];
      const mat = openMaterials[parts[1] || 'fluffy'];
      if (shape && mat) return shape + '·' + mat;
    }
    if (familyId === 'robot' && Object.hasOwn(robotVariants, variant.id)) {
      return robotVariants[variant.id];
    }
    if (familyId === 'boop') {
      const name = boopVariants[variant.id] || variant.label.replace(/^\d+\s*·\s*/, '').replace(/^软糖\s*·\s*/, '软糖');
      const skin = /^skin-(\d+)$/.exec(variant.id);
      return skin ? name + '（' + skin[1] + '）' : name;
    }
    return variant.label || variant.id;
  }

  function expressionLabel(familyId, exp) {
    if (familyId === 'open' && Object.hasOwn(openExpressions, exp.id)) {
      return openExpressions[exp.id];
    }
    if (familyId === 'classic' && Object.hasOwn(classicLabels, exp.id)) {
      return classicLabels[exp.id];
    }
    return exp.label || exp.id;
  }

  function register(family) {
    const id = family.id;
    families.set(id, Object.assign({}, family, {
      title: familyNames[id] || family.title || id,
      variants: (family.variants || []).map(v => Object.assign({}, v, {label: variantLabel(id, v)})),
      expressions: (family.expressions || []).map(e => Object.assign({}, e, {label: expressionLabel(id, e)}))
    }));
  }
  const loading = new Map();
  function loadFamily(id) {
    if (families.has(id)) return Promise.resolve();
    if (loading.has(id)) return loading.get(id);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'avatars/' + id + '/engine.js';
      script.onload = () => families.has(id) ? resolve() : reject(new Error(id));
      script.onerror = () => reject(new Error(id));
      document.head.append(script);
    }).finally(() => loading.delete(id));
    loading.set(id, promise);
    return promise;
  }
  function groupName(family, variant) {
    if (family === 'boop') {
      const num = /^skin-(\d+)$/.exec(variant.id);
      return num ? boopSeries[Math.floor(Number(num[1]) / 100)] : '经典';
    }
    if (family === 'open') {
      if (variant.id.endsWith(':glass')) return '玻璃';
      return variant.id.endsWith(':flat') ? '平涂' : '绒面';
    }
    return '';
  }
  register({
    id:'classic', variants:[{id:'night', label:'暗夜小可'}],
    expressions:Object.keys(global.GrokReference.stateData).map(id => ({id, label:classicLabels[id] || id}))
  });

  function attach(orb) {
    const el = id => document.getElementById(id);
    const host = el('avatar-engine'), app = el('app'), grid = el('avatar-grid');
    const filters = el('avatar-families'), picker = el('avatar-expression'), groups = el('avatar-group');
    let familyId, variantId, browsedId, opened = false, picked = false;
    let boopFlat = false;
    const viewButton = el('avatar-view');
    const fallback = {family:'classic', variant:'night'};

    function mount(id, variant, save, flat = boopFlat) {
      const family = families.get(id);
      const item = family?.variants.find(v => v.id === variant);
      if (!item || (id === familyId && variant === variantId && boopFlat === flat)) return;
      const numbered = id === 'boop' && variant.startsWith('skin-');
      // Construct the new head at its final size before retiring the old renderer.
      const slot = document.createElement('div');
      slot.className = 'avatar-slot';
      let next = null;
      if (id !== 'classic') {
        host.append(slot);
        try { next = family.mount(slot, numbered && flat ? variant + '-2d' : variant); }
        catch (error) {
          slot.remove();
          el('appearance-name').textContent = '头像未能载入';
          console.error('Avatar mount failed', id, error);
          return;
        }
      }
      if (orb.skin) orb.skin.destroy();
      for (const child of Array.from(host.children)) if (child !== slot) child.remove();
      orb.skin = next;
      orb.previewUntil = 0;
      familyId = id; variantId = variant; boopFlat = flat;
      viewButton.hidden = !numbered; viewButton.textContent = flat ? '平面' : '立体';
      viewButton.setAttribute('aria-pressed', String(!flat));
      app.dataset.avatar = id;
      host.dataset.variant = variant;
      el('appearance-name').textContent = item.label;
      el('appearance-credit').textContent = credits[id] || '';
      picker.replaceChildren(new Option('选择表情', ''));
      for (const exp of family.expressions) picker.add(new Option(exp.label || exp.id, exp.id));
      if (save) {
        try { global.localStorage.setItem(storageKey, JSON.stringify({family:id, variant, flat})); } catch (_) {}
      }
    }

    function showFamily(id, selectedGroup = '') {
      for (const button of filters.children) button.setAttribute('aria-pressed', String(button.dataset.family === id));
      grid.replaceChildren();
      const family = families.get(id);
      browsedId = id;
      if (!family) {
        groups.hidden = true;
        const hint = document.createElement('p'); hint.className = 'avatar-loading';
        hint.textContent = '正在载入头像…'; grid.append(hint);
        loadFamily(id).then(() => {
          if (opened && browsedId === id) showFamily(id);
        }).catch(() => {hint.textContent = '载入失败，点系列名重试';});
        return;
      }
      const names = [...new Set(family.variants.map(variant => groupName(id, variant)).filter(Boolean))];
      groups.hidden = !names.length;
      groups.replaceChildren(new Option('全部材质', ''));
      for (const name of names) groups.add(new Option(name, name));
      groups.value = selectedGroup;
      groups.onchange = () => showFamily(id, groups.value);
      for (const variant of family.variants) {
        if (selectedGroup && groupName(id, variant) !== selectedGroup) continue;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'avatar-card'; button.dataset.variant = variant.id;
        button.setAttribute('aria-pressed', String(id === familyId && variant.id === variantId));
        if (variant.thumb) {
          const img = document.createElement('img');
          img.src = variant.thumb; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
          const tile = variant.tile;
          if (Number.isInteger(tile) && tile >= 0) {
            const side = variant.side;
            const crop = document.createElement('span');
            crop.className = 'avatar-atlas';
            img.style.width = (side * 100) + '%'; img.style.height = img.style.width;
            img.style.transform = 'translate(' + (-(tile % side)*100/side) + '%,' + (-Math.floor(tile/side)*100/side) + '%)';
            crop.append(img); button.append(crop);
          } else button.append(img);
        } else {
          const icon = document.createElement('span');
          icon.className = 'avatar-mini ' + (id === 'classic' ? 'mini-orb' : 'mini-generic');
          icon.setAttribute('aria-hidden', 'true');
          button.append(icon);
        }
        const label = document.createElement('span');
        label.textContent = variant.label || variant.id;
        button.append(label);
        button.addEventListener('click', () => {
          picked = true;
          mount(id, variant.id, true);
          for (const card of grid.children) card.setAttribute('aria-pressed', String(familyId === id && card.dataset.variant === variantId));
        });
        grid.append(button);
      }
      grid.scrollTop = 0; grid.scrollLeft = 0;
    }

    for (const id of Object.keys(familyNames)) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.family = id; button.textContent = familyNames[id];
      button.addEventListener('click', () => showFamily(id));
      filters.append(button);
    }
    viewButton.addEventListener('click', () => mount(familyId, variantId, true, !boopFlat));
    picker.addEventListener('change', () => {
      const id = picker.value;
      if (id && !orb.active) {
        if (orb.skin) orb.skin.express(id);
        else { orb.previewState = id; orb.previewUntil = performance.now() + 2500; }
      }
      picker.selectedIndex = 0;
    });
    let saved;
    try { saved = JSON.parse(global.localStorage.getItem(storageKey)); } catch (_) {}
    mount(fallback.family, fallback.variant, false);
    if (saved && saved.family !== 'classic' && Object.hasOwn(familyNames,saved.family)) {
      loadFamily(saved.family).then(() => {
        if (!picked) {
          mount(saved.family,saved.variant,false,saved.flat === true);
          if (opened && browsedId === familyId) showFamily(familyId);
        }
      }).catch(() => {});
    }

    return {
      setOpen(open) {
        if (opened === open) return;
        opened = open;
        app.classList.toggle('appearance-open', open);
        if (open) {
          showFamily(familyId);
          requestAnimationFrame(() => {
            if (!opened) return;
            grid.querySelector('[aria-pressed=true]')?.scrollIntoView({block:'nearest', inline:'nearest'});
            el('appearance-done').focus({preventScroll:true});
          });
        }
      }
    };
  }
  global.NightAvatars = {register, attach};
})(window);
