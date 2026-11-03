'use strict';
// 经营：资金、拨款、票款、运营费用、满意度、失败判定；任务：历史参考任务与动态任务
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA;

  // 月度账本。科目严格区分：
  //   财政收入 grant 拨款 · fare 票款 · reward 任务奖励
  //   融资到账 bond（债券募集，进入建设专项资金，不算收入）
  //   建设支出 construction · demolition · upgrade · relocation（其中 capexUse 为专项资金支付的部分）
  //   运营成本 ops · 利息 interest · 本金偿还 principal · 逾期费用 penalty
  function blankMonth(y, m, funds, capex) {
    return { y: y, m: m, start: funds, grant: 0, fare: 0, construction: 0, demolition: 0, upgrade: 0, relocation: 0, ops: 0, reward: 0,
      bond: 0, interest: 0, principal: 0, penalty: 0, capexUse: 0, capexStart: capex || 0, days: 0, wdDays: 0, weDays: 0, end: funds };
  }
  const BUILD_KINDS = ['construction', 'demolition', 'upgrade', 'relocation'];
  const MONEY_EPS = 1e-7;   // 内部单位是万元；只忽略浮点误差，不能把不足 0.5 万的真实债务清零
  Economy.BUILD_KINDS = BUILD_KINDS;
  Economy.MONEY_EPS = MONEY_EPS;

  function Economy(mode, y, m) {
    this.mode = mode;
    this.funds = mode === 'free' ? 0 : CFG.economy.startFunds;   // 一般资金（拨款、票款等；运营、利息与还本只能从这里支付）
    this.capex = 0;            // 建设专项资金：债券募集，只能用于地铁建设及改扩建
    this.bonds = [];           // 已发行的债券
    this.bondIssued = {};      // 每年已发行额 { 年份: { local, ct } }
    this.overdue = 0;          // 逾期未付的本息
    this.overdueMonths = 0;    // 连续存在逾期的月数
    this.overdueParts = { interest: 0, principal: 0, penalty: 0 };   // 逾期的构成（偿还时分别记入利息、本金、费用）
    this.flow = [];            // 资金流水
    this.bondSeq = 1;
    this.fare = Economy.defaultFare();
    this.cur = blankMonth(y, m, this.funds, 0);
    this.ledger = [];
    this.sat = CFG.economy.startSat;
    this.mods = [];
    this.negMonths = 0; this.lowSatMonths = 0;
    this.failed = null;
    this.lastDay = null;
    this.satFactors = null;
    this.fisc = null;          // 财力系数 { y, f }（城市经济每年 1 月设定）
    this.quoteFn = null;       // 新发债券的利率报价（城市经济提供；不保存）
  }
  CM.Economy = Economy;

  Economy.prototype.isFree = function () { return this.mode === 'free'; };
  // 只检查新增的现金支出：零费用操作（如拆除既有设施）在负余额时也允许，便于止损
  Economy.prototype.canAfford = function (amount) { return this.isFree() || amount <= MONEY_EPS || this.funds >= amount; };
  Economy.prototype.spend = function (kind, amount) {
    if (amount <= 0) return;
    this.cur[kind] = (this.cur[kind] || 0) + amount;
    if (!this.isFree()) this.funds -= amount;
  };
  Economy.prototype.income = function (kind, amount) {
    this.cur[kind] = (this.cur[kind] || 0) + amount;
    if (!this.isFree()) this.funds += amount;
  };
  // 价格指数以本地图的价格基年（CFG.econBase）为 1，涨幅可分段
  Economy.prototype.costIndex = function (year) { return U.priceIndex(year, CFG.cost.inflation, CFG.econBase || 1990); };
  Economy.prototype.opsIndex = function (year) { return U.priceIndex(year, CFG.ops.inflation, CFG.econBase || 1990); };

  // 每日结算：票款与运营费用，按当天的日类型（工作日 / 周末）的模拟结果逐日累计（v1.9 起；之前按典型工作日）
  Economy.prototype.day = function (daily, compiled, year, dt) {
    const fareWan = daily && daily.ready ? daily.fare / 10000 : 0;
    let ops = 0;
    if (daily && compiled) {
      const oi = this.opsIndex(year);
      ops += daily.carKm * CFG.ops.carKmCost * oi;
      for (const s of compiled.stations) ops += CFG.ops.stationDaily[s.size] * oi;
    }
    this.income('fare', fareWan);
    this.spend('ops', ops);
    this.cur.days++;
    if (dt === 'we') this.cur.weDays = (this.cur.weDays || 0) + 1; else if (dt === 'wd') this.cur.wdDays = (this.cur.wdDays || 0) + 1;
    this.lastDay = { fare: fareWan, ops: ops, dt: dt || null };
  };

  // 拨款与满意度调整（mods）：until 为最后一个生效的月份（含当月），N 个月的效果记为 ym + N − 1
  // 财力系数（城市经济，macro.js）：上一年实际地方财政收入 ÷ 预期，每年 1 月确定一次；没有城市经济的地图为 1
  Economy.prototype.fiscalFactor = function () { return this.fisc && isFinite(this.fisc.f) ? this.fisc.f : 1; };
  // 基础额度：按城市与年代设定的地铁资金基数（不含财力、满意度与任务调整）。
  // 历史末年（通常 2020 年）之后：以末年额度为基数，按城市经济的预期地方财政收入增长（macro.js syncEcon 提供 revIdx；
  // v2.1 第二轮：原来只按固定表每年约 1.7% 增长，跟不上城市财力与运营成本，后期入不敷出）。没有城市经济的地图仍按表
  Economy.prototype.grantQuota = function (y, m) {
    const t = y + ((m || 1) - 1) / 12, R = this.revIdx;
    if (!R || t <= R.he) return U.interp(CFG.economy.grantBase, t);
    return U.interp(CFG.economy.grantBase, R.he) * R.f(t);
  };
  Economy.prototype.grantFor = function (y, m) {
    const ym = U.ymIndex(y, m);
    let f = 0.6 + 0.8 * this.sat / 100, mf = 1;
    for (const md of this.mods) if (md.kind === 'grant' && md.until >= ym) mf *= md.factor;
    return this.grantQuota(y, m) * this.fiscalFactor() * f * Math.max(0.6, mf);
  };
  Economy.prototype.grantFactors = function (y, m) {
    const ym = U.ymIndex(y, m);
    const list = [];
    if (this.fisc) list.push({ label: '财力系数（' + (this.fisc.y || y) + ' 年预算）', f: this.fiscalFactor(), kind: 'fisc' });
    list.push({ label: '满意度系数（' + Math.round(this.sat) + '）', f: 0.6 + 0.8 * this.sat / 100, kind: 'sat' });
    for (const md of this.mods) if (md.kind === 'grant' && md.until >= ym) list.push({ label: md.reason + '（至 ' + Math.floor(md.until / 12) + '年' + (md.until % 12 + 1) + '月）', f: md.factor, kind: 'task' });
    return list;
  };
  // 新月份：先开新账（期初 = 上月期末），任务奖励等记入新月；再发放本月拨款
  Economy.prototype.openMonth = function (y, m) { this.cur = blankMonth(y, m, this.funds, this.capex); };
  Economy.prototype.payGrant = function (y, m) {
    if (!this.isFree()) { const v = this.grantFor(y, m); this.income('grant', v); this.log('grant', v, 'gen', '政府拨款', { y: y, m: m, d: 1 }); }
    else this.cur.grant = 0;
  };
  Economy.prototype.startMonth = function (y, m) { this.openMonth(y, m); this.payGrant(y, m); };
  // 封账：记录期末并归档；之后的收支一律记入下一个月
  Economy.prototype.closeMonth = function () {
    this.cur.end = this.funds;
    this.cur.capexEnd = this.capex;
    this.cur.debtEnd = this.debtTotal();
    this.cur.overdueEnd = this.overdue;
    // 票款与运营费用逐日结算，在流水中按月汇总为两条
    if (!this.isFree()) {
      const c = this.cur, when = { y: c.y, m: c.m, d: U.daysInMonth(c.y, c.m) };
      if (c.fare > 0.5) this.log('fare', c.fare, 'gen', '本月票款（' + c.days + ' 天' + (c.wdDays || c.weDays ? '：' + (c.wdDays || 0) + ' 个工作日、' + (c.weDays || 0) + ' 个周末日' : '') + '）', when);
      if (c.ops > 0.5) this.log('ops', -c.ops, 'gen', '本月运营成本（' + c.days + ' 天）', when);
    }
    this.cur.closed = true;
    this.ledger.push(this.cur);
    if (this.ledger.length > 600) this.ledger.shift();
    return this.cur;
  };

  // 满意度（0–100）：通勤、覆盖、拥堵、票价负担、拥挤。daily 为周平均日（5 个工作日 + 2 个周末日加权），
  // 通勤时间按工作日（model.dailyWk）；opts.protect：交通模型升级过渡期，满意度不下降
  Economy.prototype.updateSatisfaction = function (daily, model, y, m, opts) {
    if (!daily || !daily.ready) return;
    const vot = U.interp(CFG.choice.vot, y);
    const wk = model && model.dailyWk && model.dailyWk.ready ? model.dailyWk : daily;
    const f = [];
    f.push({ label: '平均通勤时间（工作日 ' + Math.round(wk.commute) + ' 分钟）', v: 14 * U.clamp((40 - wk.commute) / 15, -1, 1) });
    f.push({ label: '地铁覆盖（' + U.fmtPct(daily.coverage, 0) + ' 人口）', v: 12 * U.clamp(daily.coverage / 0.5, 0, 1) });
    f.push({ label: '道路拥堵（周平均指数 ' + daily.cong.toFixed(2) + '）', v: -14 * U.clamp((daily.cong - 1.25) / 0.8, 0, 1) });
    const burden = daily.metro > 1 ? daily.avgFare / (vot * 0.35) : 0;
    f.push({ label: '票价负担（平均 ' + U.cur(daily.avgFare).toFixed(U.cur(daily.avgFare) < 10 ? 2 : 1) + ' ' + CFG.money.unit + '）', v: -9 * U.clamp((burden - 1) / 2, 0, 1) });
    f.push({ label: '车厢拥挤（周平均超载客公里 ' + U.fmtPct(daily.crowdShare, 0) + '）', v: -9 * U.clamp(daily.crowdShare / 0.25, 0, 1) });
    const ym = U.ymIndex(y, m);
    for (const md of this.mods) if (md.kind === 'sat' && md.until >= ym) f.push({ label: md.reason, v: md.delta });
    // 历史事件的满意度效果（v2.2，如大型国际活动），按时间计算
    if (CM.Eras) for (const x of CM.Eras.satBonus(y + (m - 1) / 12)) if (Math.abs(x.v) > 0.05) f.push({ label: x.label, v: x.v });
    let target = 55;
    for (const x of f) target += x.v;
    target = U.clamp(target, 0, 100);
    const next = U.clamp(this.sat + (target - this.sat) * 0.25, 0, 100);
    const prot = !!(opts && opts.protect) && next < this.sat;
    this.sat = prot ? this.sat : next;
    this.satFactors = { base: 55, factors: f, target: target, basis: 'avg', protected: prot };
  };

  // 失败判定（仅经营挑战）。protect：交通模型升级过渡期，满意度不足的月数不累计
  Economy.prototype.checkFailure = function (y, protect) {
    if (this.isFree() || this.failed) return null;
    const E = CFG.economy;
    const limit = E.debtLimit * this.costIndex(y);
    this.negMonths = this.funds < 0 ? this.negMonths + 1 : 0;
    this.lowSatMonths = this.sat < E.satFail ? (protect ? this.lowSatMonths : this.lowSatMonths + 1) : 0;
    const reasons = [];
    if (this.funds < limit) reasons.push('资金低于负债下限（' + U.fmtMoney(this.funds) + '，下限 ' + U.fmtMoney(limit) + '）');
    if (this.negMonths >= E.negMonthsLimit) reasons.push('连续 ' + this.negMonths + ' 个月负余额（上限 ' + E.negMonthsLimit + ' 个月）');
    if (this.lowSatMonths >= E.satFailMonths) reasons.push('居民满意度连续 ' + this.lowSatMonths + ' 个月低于 ' + E.satFail + '，交通持续恶化');
    if (reasons.length) { this.failed = { reasons: reasons }; return this.failed; }
    return null;
  };
  Economy.prototype.warnings = function () {
    if (this.isFree()) return [];
    const E = CFG.economy, out = [];
    if (this.negMonths > 0) out.push({ level: this.negMonths >= E.negMonthsLimit * 0.6 ? 'danger' : 'warn', text: '财政预警：已连续 ' + this.negMonths + ' 个月负余额（满 ' + E.negMonthsLimit + ' 个月挑战失败）' });
    if (this.lowSatMonths > 0) out.push({ level: this.lowSatMonths >= E.satFailMonths * 0.6 ? 'danger' : 'warn', text: '交通预警：满意度已连续 ' + this.lowSatMonths + ' 个月低于 ' + E.satFail + '（满 ' + E.satFailMonths + ' 个月挑战失败）' });
    // 票价不会自动随物价调整：实际价值（按造价指数折回价格基年）跌破开局默认票价的一半时提醒（长时间跨度、物价变化大的地图，如巴黎）
    const f0 = CFG.fareDefault && CFG.fareDefault.flat, y = this.cur && this.cur.y;
    if (CFG.fareRange && CFG.fareRange.scale && f0 > 0 && y && this.fare.flat > 0) {
      const real = this.fare.flat / this.costIndex(y) / f0;
      if (real < 0.5) out.push({ level: 'warn', text: '票价预警：票价没有随物价调整，实际价值只剩开局时的 ' + Math.round(real * 100) + '%，可在财政页调整票价' });
    }
    return out;
  };

  // ======================== 资金流水 ========================
  // kind：grant / fare / ops / reward / build / bond / interest / principal / penalty / overdue / repay；acct：gen 一般资金、capex 建设专项资金
  Economy.prototype.log = function (kind, amount, acct, note, when) {
    if (this.isFree()) return;
    const w = when || this._now || { y: this.cur.y, m: this.cur.m, d: 1 };
    this.flow.push({ y: w.y, m: w.m, d: w.d || 1, kind: kind, amount: amount, acct: acct, note: note, bal: this.funds, cap: this.capex });
    if (this.flow.length > 400) this.flow.splice(0, this.flow.length - 400);
  };

  // ======================== 建设支出：先用建设专项资金，不足部分用一般资金 ========================
  Economy.prototype.canAffordBuild = function (amount) { return this.isFree() || amount <= MONEY_EPS || Math.max(0, this.funds) + Math.max(0, this.capex) >= amount; };
  Economy.prototype.spendBuild = function (byKind, note, when) {
    let total = 0; for (const k of BUILD_KINDS) total += byKind[k] || 0;
    if (total <= 0) return { total: 0, capex: 0, gen: 0 };
    for (const k of BUILD_KINDS) if (byKind[k] > 0) this.cur[k] = (this.cur[k] || 0) + byKind[k];
    if (this.isFree()) return { total: total, capex: 0, gen: 0 };
    const use = Math.min(Math.max(0, this.capex), total), gen = total - use;
    this.capex -= use; this.funds -= gen; this.cur.capexUse = (this.cur.capexUse || 0) + use;
    if (use > 0.5) this.log('build', -use, 'capex', (note || '地铁建设') + '（专项资金）', when);
    if (gen > 0.5) this.log('build', -gen, 'gen', (note || '地铁建设') + (use > 0.5 ? '（专项不足部分）' : ''), when);
    return { total: total, capex: use, gen: gen };
  };

  // ======================== 债券融资（仅经营挑战） ========================
  // 地方债：利率较低、额度较大；城投债：利率较高、额度较小。利率在发行时按当年利率固定，6 年期另加期限溢价。
  // 年度发行额度与总债务上限按当年基础月拨款的倍数计算（随城市与年代变化），只能用于地铁建设及改扩建。
  const BOND_DEF = {
    local: { name: '地方债', desc: '由城市政府发行，利率较低、额度较大' },
    ct: { name: '城投债', desc: '由城市建设投资公司发行，利率较高、额度较小，有逾期时暂停发行' },
  };
  Economy.BOND_DEF = BOND_DEF;
  Economy.prototype.bondCfg = function () { return CFG.economy.bonds || null; };
  Economy.prototype.canBorrow = function () { return !this.isFree() && !!this.bondCfg(); };
  // 当年基础月拨款（含财力系数，不含满意度与任务调整）：融资额度与债务上限按此计算
  Economy.prototype.baseGrant = function (y) { return this.grantQuota(y, 1) * this.fiscalFactor(); };
  // 新发行债券的利率报价：有城市经济时按经济环境与财政状况浮动（macro.js）；已发行债券按合同利率，不受影响
  Economy.prototype.bondQuote = function (kind, y, term) {
    if (this.quoteFn) { try { const q = this.quoteFn(kind, y, term); if (q && isFinite(q.rate)) return q; } catch (e) { console.error(e); } }
    const B = this.bondCfg(); if (!B) return { rate: 0, parts: [] };
    const local = U.interp(B.local.rate, y);
    const parts = [{ k: 'base', label: '基准利率（' + y + ' 年市场水平）', v: local }];
    let r = local;
    if (kind === 'ct') { const sp = B.ct.rate ? U.interp(B.ct.rate, y) - local : (B.ct.spread || 0.015); parts.push({ k: 'ct', label: '城投债利差', v: sp }); r += sp; }
    if (term === 6) { const tp = B.term6 || 0.004; parts.push({ k: 'term', label: '6 年期期限溢价', v: tp }); r += tp; }
    return { rate: r, parts: parts };
  };
  Economy.prototype.bondRate = function (kind, y, term) { return this.bondQuote(kind, y, term).rate; };
  Economy.prototype.bondQuota = function (kind, y) { const B = this.bondCfg(); return B ? B[kind].quotaMonths * this.baseGrant(y) : 0; };
  Economy.prototype.bondCap = function (kind, y) { const B = this.bondCfg(); return B ? B[kind].capMonths * this.baseGrant(y) : 0; };
  Economy.prototype.issuedIn = function (kind, y) { const a = this.bondIssued[y]; return a ? (a[kind] || 0) : 0; };
  Economy.prototype.outstanding = function (kind) { let s = 0; for (const b of this.bonds) if (!b.done && (!kind || b.kind === kind)) s += b.amount; return s; };
  // 已到期但尚未偿还的本金仍占用债务上限，不能通过逾期腾出发行空间。
  Economy.prototype.principalDebt = function (kind) { let s = this.outstanding(kind); for (const b of this.bonds) if (b.done && (!kind || b.kind === kind)) s += b.principalArrears || 0; return s; };
  Economy.prototype.bondSettled = function (b) { return !!b.done && (b.interestArrears || 0) <= MONEY_EPS && (b.principalArrears || 0) <= MONEY_EPS; };
  Economy.prototype.debtTotal = function () { return this.outstanding() + this.overdue; };
  // 融资限制：有逾期时暂停城投债；逾期满 6 个月暂停全部发行
  Economy.prototype.bondBlock = function (kind) {
    if (!this.canBorrow()) return '只有经营挑战可以发行债券';
    if (this.failed) return '经营挑战已失败';
    if (this.overdueMonths >= 6) return '逾期已满 ' + this.overdueMonths + ' 个月，暂停全部债券发行（还清逾期后恢复）';
    if (kind === 'ct' && this.overdue > MONEY_EPS) return '存在逾期债务，城投债暂停发行（还清逾期后恢复）';
    return null;
  };
  Economy.prototype.bondRoom = function (kind, y) {
    return Math.max(0, Math.min(this.bondQuota(kind, y) - this.issuedIn(kind, y), this.bondCap(kind, y) - this.principalDebt(kind)));
  };
  Economy.prototype.issueBond = function (kind, term, amount, when) {
    if (!BOND_DEF[kind]) return { ok: false, error: '债券类型无效' };
    const y = when.y, block = this.bondBlock(kind);
    if (block) return { ok: false, error: block };
    if (term !== 3 && term !== 6) return { ok: false, error: '期限只能是 3 年或 6 年' };
    amount = Math.round(amount);
    if (!(amount > 0)) return { ok: false, error: '发行金额必须大于 0' };
    const room = this.bondRoom(kind, y);
    if (amount > room + MONEY_EPS) return { ok: false, error: '超出本年度可发行额度（剩余 ' + U.fmtMoney(room) + '）' };
    const q = this.bondQuote(kind, y, term), rate = q.rate;
    // 合同利率在发行时固定，并记录当时的报价构成（之后的市场与财政变化不影响已发行债券）
    const b = { id: 'B' + (this.bondSeq++), kind: kind, amount: amount, rate: rate, term: term, issued: [when.y, when.m, when.d || 1], ym0: U.ymIndex(when.y, when.m), paidYears: 0, interestPaid: 0, interestArrears: 0, principalArrears: 0, done: false,
      quote: q.parts.map(function (p) { return [p.label, Math.round(p.v * 1e6) / 1e6]; }) };
    this.bonds.push(b);
    (this.bondIssued[y] || (this.bondIssued[y] = { local: 0, ct: 0 }))[kind] += amount;
    this.capex += amount;
    this.cur.bond = (this.cur.bond || 0) + amount;
    this.log('bond', amount, 'capex', BOND_DEF[kind].name + ' ' + term + ' 年期 · 年利率 ' + (rate * 100).toFixed(2) + '%', when);
    return { ok: true, bond: b };
  };
  // 从一般资金付款：只用正的余额；不足部分记为逾期
  Economy.prototype.payFromFunds = function (kind, amount, note, when, bond) {
    if (amount <= 0) return 0;
    const paid = Math.min(Math.max(0, this.funds), amount);
    if (paid > 0) { this.funds -= paid; this.cur[kind] = (this.cur[kind] || 0) + paid; this.log(kind, -paid, 'gen', note, when); }
    const short = amount - paid;
    if (bond && kind === 'interest') bond.interestPaid = (bond.interestPaid || 0) + paid;
    if (short > MONEY_EPS) {
      const P = this.odParts(); this.overdue += short; P[kind] = (P[kind] || 0) + short;
      if (bond) bond[kind + 'Arrears'] = (bond[kind + 'Arrears'] || 0) + short;
      this.log('overdue', -short, 'gen', note + '：资金不足，转为逾期', when);
    }
    return paid;
  };
  // 每月（拨款发放后）：先偿还旧逾期，再支付到期的利息与本金，最后按逾期月数收取逾期费用。
  // paidYears 记录已结算的付息期数（含转逾期）；实际付款单独记录，跨周年补齐遗漏的期次。
  Economy.prototype.serviceDebt = function (y, m) {
    if (this.isFree() || !this.bonds) return;
    const ym = U.ymIndex(y, m), when = { y: y, m: m, d: 1 };
    if (this._svc === ym) return;
    this._svc = ym;
    // 偿还旧逾期：按费用、利息、本金的顺序，分别记入对应科目
    if (this.overdue > MONEY_EPS && this.funds > 0) {
      const P = this.odParts();
      for (const k of ['penalty', 'interest', 'principal']) {
        const pay = Math.min(Math.max(0, this.funds), P[k] || 0); if (pay <= 0) continue;
        this.funds -= pay; P[k] -= pay; this.overdue -= pay; this.cur[k] = (this.cur[k] || 0) + pay;
        // 逾期还款也要回写到债券，不能一直显示为未付，或把从未支付的利息显示为已付。
        if (k === 'interest' || k === 'principal') {
          let left = pay;
          for (const b of this.bonds) {
            const key = k + 'Arrears', take = Math.min(left, b[key] || 0);
            if (take <= 0) continue;
            b[key] = Math.max(0, b[key] - take); left -= take;
            if (k === 'interest') b.interestPaid = (b.interestPaid || 0) + take;
            if (this.bondSettled(b)) b.repaid = [y, m];
            if (left <= MONEY_EPS) break;
          }
        }
        this.log('repay', -pay, 'gen', '偿还逾期' + { penalty: '费用', interest: '利息', principal: '本金' }[k], when);
      }
      if (this.overdue <= MONEY_EPS) { this.overdue = 0; this.overdueParts = { interest: 0, principal: 0, penalty: 0 }; }
    }
    for (const b of this.bonds) {
      const dueYears = Math.min(b.term, Math.floor((ym - b.ym0) / 12));
      if (b.done || dueYears <= b.paidYears) continue;
      const name = BOND_DEF[b.kind].name + ' ' + b.id + '（' + b.issued[0] + '年' + b.issued[1] + '月发行）';
      const it = b.amount * b.rate;
      for (let k = b.paidYears + 1; k <= dueYears; k++) {
        b.paidYears = k;
        this.payFromFunds('interest', it, name + ' 第 ' + k + ' 年利息', when, b);
      }
      if (dueYears >= b.term) {
        b.done = true;
        this.payFromFunds('principal', b.amount, name + ' 到期还本', when, b);
        if (this.bondSettled(b)) b.repaid = [y, m];
      }
    }
    if (this.overdue > MONEY_EPS) {
      this.overdueMonths++;
      const rate = this.overdueMonths >= 12 ? 0.02 : (this.overdueMonths >= 6 ? 0.015 : 0.01);
      this.payFromFunds('penalty', this.overdue * rate, '逾期费用（月 ' + (rate * 100).toFixed(1) + '%，已逾期 ' + this.overdueMonths + ' 个月）', when);
    } else { this.overdue = 0; this.overdueMonths = 0; this.overdueParts = { interest: 0, principal: 0, penalty: 0 }; }
  };
  // 未来偿债预测：按年汇总已发行债券的利息与到期本金（不含尚未发生的逾期费用）
  Economy.prototype.odParts = function () {
    if (!this.overdueParts) {
      let interest = 0, principal = 0;
      for (const b of this.bonds) { interest += b.interestArrears || 0; principal += b.principalArrears || 0; }
      this.overdueParts = { interest: interest, principal: principal, penalty: Math.max(0, (this.overdue || 0) - interest - principal) };
    }
    return this.overdueParts;
  };
  Economy.prototype.debtForecast = function (y, m, years) {
    const ym = U.ymIndex(y, m), rows = [];
    for (let k = 0; k < years; k++) rows.push({ y: y + k, interest: 0, principal: 0 });
    for (const b of this.bonds) {
      if (b.done) continue;
      for (let k = b.paidYears + 1; k <= b.term; k++) {
        const t = b.ym0 + 12 * k; if (t < ym) continue;
        const r = rows[Math.floor(t / 12) - y]; if (!r) continue;
        r.interest += b.amount * b.rate;
        if (k === b.term) r.principal += b.amount;
      }
    }
    return rows;
  };

  Economy.prototype.serialize = function () {
    return { mode: this.mode, funds: this.funds, fare: this.fare, cur: this.cur, ledger: this.ledger, sat: this.sat, mods: this.mods, negMonths: this.negMonths, lowSatMonths: this.lowSatMonths, failed: this.failed, satFactors: this.satFactors, lastDay: this.lastDay,
      capex: this.capex, bonds: this.bonds, bondIssued: this.bondIssued, overdue: this.overdue, overdueParts: this.overdueParts || null, overdueMonths: this.overdueMonths, flow: this.flow, bondSeq: this.bondSeq, svc: this._svc == null ? null : this._svc,
      fisc: this.fisc || null };
  };
  Economy.restore = function (s) {
    const e = new Economy(s.mode, s.cur.y, s.cur.m);
    Object.assign(e, { funds: s.funds, fare: Economy.normFare(s.fare), cur: s.cur, ledger: s.ledger || [], sat: s.sat, mods: s.mods || [], negMonths: s.negMonths || 0, lowSatMonths: s.lowSatMonths || 0, failed: s.failed || null, satFactors: s.satFactors || null, lastDay: s.lastDay || null,
      capex: s.capex || 0, bonds: s.bonds || [], bondIssued: s.bondIssued || {}, overdue: s.overdue || 0, overdueParts: s.overdueParts || null, overdueMonths: s.overdueMonths || 0, flow: s.flow || [], bondSeq: s.bondSeq || 1 });
    e._svc = s.svc == null ? null : s.svc;
    e.fisc = s.fisc && isFinite(s.fisc.f) ? { y: s.fisc.y, f: s.fisc.f } : null;   // 1.7 及更早的存档没有财力系数，按 1 处理
    // 1.6 及更早的正式存档没有债券，默认债务为零。早期 1.7 开发档可能只保存逾期总账，
    // 没有每券构成：从较晚发行的债券开始分摊剩余逾期，保留总额、已用额度与现金余额。
    const P = e.odParts();
    for (const kind of ['interest', 'principal']) {
      const key = kind + 'Arrears';
      let remaining = Math.max(0, (P[kind] || 0) - e.bonds.reduce(function (sum, b) { return sum + (b[key] || 0); }, 0));
      for (let i = e.bonds.length - 1; i >= 0; i--) {
        const b = e.bonds[i];
        if (b[key] != null) continue;
        const due = kind === 'interest' ? b.amount * b.rate * Math.min(b.term, b.paidYears || 0) : (b.done ? b.amount : 0);
        b[key] = Math.min(remaining, due); remaining -= b[key];
        if (kind === 'interest') b.interestPaid = Math.max(0, Math.min(due, b.interestPaid == null ? due : b.interestPaid) - b[key]);
      }
    }
    for (const b of e.bonds) {
      if (!e.bondSettled(b)) delete b.repaid;
      const seq = /^B(\d+)$/.exec(b.id);
      if (seq) e.bondSeq = Math.max(e.bondSeq, Number(seq[1]) + 1);
    }
    // 旧存档的账本没有新科目：补零，保证收支汇总不出现 NaN
    for (const r of e.ledger.concat([e.cur])) for (const k of ['bond', 'interest', 'principal', 'penalty', 'capexUse']) if (r[k] == null) r[k] = 0;
    return e;
  };
  // 票价（v2.1 第二轮）：统一票价 { mode: 'flat', flat } 或按里程计费 { mode: 'dist', flat 起步价, km0 起步里程, step 每段公里, inc 每段加价, cap 封顶（0 不封顶） }。
  // 统一票价存档读入后与原来完全相同；更早版本的里程计价存档（没有 km0 字段）仍按起步价换算为统一票价
  const fareQ = function (v, lo, hi) { const R = CFG.fareRange; return U.clamp(+(Math.round(v / R.step) * R.step).toFixed(6), lo, hi); };
  Economy.normFare = function (f) {
    const R = CFG.fareRange, D = CFG.fareDist, newDist = !!f && f.mode === 'dist' && f.km0 != null;
    let v = f ? (f.mode === 'flat' || newDist ? f.flat : f.base) : CFG.fareDefault.flat;
    if (!isFinite(v)) v = CFG.fareDefault.flat;
    if (!newDist) return { mode: 'flat', flat: U.clamp(Math.round(v / R.step) * R.step, R.min, R.max) };
    const num = function (x, d) { x = +x; return isFinite(x) ? x : d; };
    const flat = fareQ(v, R.min, R.max), cap = fareQ(num(f.cap, 0), 0, R.max * 5);
    return { mode: 'dist', flat: flat, km0: U.clamp(num(f.km0, D.km0), 0, 50), step: U.clamp(num(f.step, D.step), 0.5, 50),
      inc: fareQ(num(f.inc, 0), 0, R.max), cap: cap > 0 ? Math.max(flat, cap) : 0 };
  };
  // 新开局的票价：按里程计费，起步价沿用本图默认票价，加价与封顶按起步价的比例取整；
  // fareDefault.dist 为 false 的地图（巴黎地铁历来单一票价）仍为统一票价
  Economy.defaultFare = function () {
    const R = CFG.fareRange, D = CFG.fareDist, f0 = CFG.fareDefault.flat;
    if (CM.mapId === 'pa' || CFG.fareDefault.dist === false || !D) return { mode: 'flat', flat: f0 };
    return { mode: 'dist', flat: f0, km0: D.km0, step: D.step, inc: Math.max(R.step, fareQ(f0 * D.inc, 0, R.max)), cap: fareQ(f0 * D.cap, 0, R.max * 5) };
  };
  // 票价对满意度的影响（与月度满意度计算同一公式）
  Economy.fareSatEffect = function (fare, year) {
    const vot = U.interp(CFG.choice.vot, year);
    const burden = fare / (vot * 0.35);
    return -9 * U.clamp((burden - 1) / 2, 0, 1);
  };

  // ======================== 任务 ========================
  function Tasks() {
    this.active = []; this.done = []; this.failed = [];
    this.issued = {};
    this.nextDyn = 0; this.seq = 1;
  }
  CM.Tasks = Tasks;

  // 网络连通分量（线路 + 站外换乘）
  function stationComponents(C, acc) {
    const N = C.stations.length, par = new Int32Array(N);
    for (let i = 0; i < N; i++) par[i] = i;
    const find = function (x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const uni = function (a, b) { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    for (const r of C.routes) for (let k = 1; k < r.stIdx.length; k++) uni(r.stIdx[0], r.stIdx[k]);
    if (acc) for (const t of acc.transfers) uni(t.a, t.b);
    return { find: find, serviced: C.serviced };
  }
  Tasks.stationComponents = stationComponents;

  // 统计口径（v1.9）：通勤、上学与高峰类目标用工作日数据，旅游与商业休闲类可用周末数据，长期客流目标用周平均
  Tasks.BASIS = { wd: '工作日', we: '周末', avg: '周平均（5 个工作日 + 2 个周末日）', wdAM: '工作日早高峰', wdPeak: '工作日高峰小时', ledger: '上月实际账目', net: '线路连通', cover: '步行 15 分钟覆盖' };
  Tasks.basisOf = function (t) {
    switch (t.type) {
      case 'connect': return 'net';
      case 'coverage': case 'zoneCov': return 'cover';
      case 'zoneCong': return 'wdAM';
      case 'stationCrowd': return 'wdPeak';
      case 'ridership': return t.basis || 'avg';
      case 'recovery': return 'ledger';
      case 'facShare': return t.basis || 'avg';
      default: return null;
    }
  };
  // 重要设施任务的口径：枢纽按周平均，上学、就医、商务与会展按工作日，商圈、景点、公园与体育场馆按周末
  Tasks.facBasis = function (f) {
    if (f.T.hub) return 'avg';
    if (f.t === 'uni' || f.t === 'hosp' || f.t === 'cbd' || f.t === 'venue') return 'wd';
    return 'we';
  };
  // 设施能否由玩家接驳（v2.2 修正）：场地边缘约 600 m 内存在可以合法设站的位置（含风景区景区站与未开放区域规则）；
  // 只为能完成的设施发布接驳任务。结果按设施与年份缓存
  const servCache = new Map();
  Tasks.facServable = function (city, f) {
    if (f.ext) return true;
    const key = city.uid + ':' + f.id + ':' + city.terrainVer + ':' + city.lockVer + ':' + (city.unlockAll ? 1 : 0);
    if (servCache.has(key)) return servCache.get(key);
    const lm = f.lmK >= 0 ? CM.DATA.landmarks[f.lmK] : null;
    const R = (lm ? Math.max(lm.w || 0, lm.d || 0) / 2 / CM.CFG.CELL_M : Math.max(0.5, f.r || 0)) + 2.4;
    let ok = false;
    for (let dy = -R; dy <= R && !ok; dy += 0.5) for (let dx = -R; dx <= R && !ok; dx += 0.5) {
      if (dx * dx + dy * dy > R * R) continue;
      if (CM.Metro.checkSite(city, f.x + dx, f.y + dy, 'underground').ok) ok = true;
    }
    if (servCache.size > 400) servCache.clear();
    servCache.set(key, ok);
    return ok;
  };
  Tasks.facShareOf = function (model, f, basis) {
    const s = model.facStats(f.id, basis); if (!s) return null;
    const vol = f.T.hub ? s.inn + s.out : s.inn, m = f.T.hub ? s.innM + s.outM : s.innM;
    return { vol: vol, share: vol > 0 ? m / vol : 0 };
  };

  Tasks.prototype.evaluate = function (t, g) {
    const C = g.compiled, model = g.model, acc = model.net ? model.net.acc : null;
    if (t.type === 'connect') {
      const comp = stationComponents(C, acc);
      const anchorSets = t.anchors.map(function (a) {
        const set = [];
        C.stations.forEach(function (s, i) { if (C.serviced[i] && U.dist(s.x, s.y, a.x, a.y) <= a.r) set.push(i); });
        return set;
      });
      const hits = anchorSets.map(function (s) { return s.length > 0; });
      let ok = false;
      if (hits.every(Boolean)) {
        const roots = anchorSets.map(function (s) { return new Set(s.map(comp.find)); });
        for (const r of roots[0]) if (roots.every(function (S) { return S.has(r); })) { ok = true; break; }
      }
      const n = hits.filter(Boolean).length;
      return { ok: ok, value: ok ? 1 : n / (t.anchors.length + 1), text: t.anchors.map(function (a, i) { return (hits[i] ? '✓ ' : '✗ ') + a.name; }).join('；') + (hits.every(Boolean) && !ok ? '（车站尚未连通）' : '') };
    }
    if (t.type === 'coverage') {
      const v = acc ? acc.coverage : 0;
      return { ok: v >= t.target, value: v / t.target, text: '当前覆盖 ' + U.fmtPct(v) + ' / 目标 ' + U.fmtPct(t.target, 0) };
    }
    if (t.type === 'zoneCong' && t.metric==='carShare') {
      const v=model.zoneTraffic(t.zone).carShare;
      return{ok:v<=t.target,value:U.clamp((t.start-v)/Math.max(.001,t.start-t.target),0,1),text:'片区工作日早高峰汽车出行占比 '+U.fmtPct(v,1)+' / 目标 ≤ '+U.fmtPct(t.target,1),sample:v};
    }
    if (t.type === 'zoneCong') {
      const v = g.zoneCong(t.zone, 'wd');
      return { ok: v <= t.target, value: U.clamp((t.start - v) / Math.max(0.01, t.start - t.target), 0, 1), text: '工作日早高峰拥堵指数 ' + v.toFixed(2) + ' / 目标 ≤ ' + t.target.toFixed(2) };
    }
    if (t.type === 'zoneCov') {
      const v = acc ? acc.zCov[t.zone] : 0;
      return { ok: v >= t.target, value: v / t.target, text: '该片区覆盖 ' + U.fmtPct(v) + ' / 目标 ' + U.fmtPct(t.target, 0) };
    }
    if (t.type === 'stationCrowd') {
      const i = C.sIndex.get(t.station);
      if (i === undefined) return { ok: false, value: 0, text: '车站已拆除' };
      const sd = model.stDailyWk || model.stDaily;
      const peak = sd && !model.dailyStale ? sd.peak[i] || 0 : 0;
      const cap = CFG.metro.stationCap[C.stations[i].size];
      const v = peak / cap;
      return { ok: v <= t.target, value: U.clamp((t.start - v) / Math.max(0.01, t.start - t.target), 0, 1), text: '工作日高峰负荷 ' + U.fmtPct(v, 0) + ' / 目标 ≤ ' + U.fmtPct(t.target, 0) };
    }
    if (t.type === 'ridership') {
      const b = Tasks.basisOf(t), d = model.dailyFor ? model.dailyFor(b) : model.daily;
      const v = d ? d.metro : 0;
      return { ok: v >= t.target, value: v / t.target, text: (b === 'wd' ? '工作日' : (b === 'we' ? '周末' : '日均（周平均）')) + '客运量 ' + U.fmtPeople(v) + ' / 目标 ' + U.fmtPeople(t.target) };
    }
    if (t.type === 'facShare') {
      const f = CM.Fac && CM.Fac.byId(t.fac);
      if (!f || model.facIndex(t.fac) < 0) return { ok: false, value: 0, text: '设施目前不在运营' };
      const r = Tasks.facShareOf(model, f, t.basis);
      if (!r) return { ok: false, value: 0, text: '客流计算中' };
      return { ok: r.share >= t.target, value: U.clamp(r.share / t.target, 0, 1), text: (t.basis === 'we' ? '周末' : (t.basis === 'wd' ? '工作日' : '周平均')) + '乘地铁' + (f.T.hub ? '接驳' : '到访') + '比例 ' + U.fmtPct(r.share, 0) + ' / 目标 ' + U.fmtPct(t.target, 0) };
    }
    if (t.type === 'recovery') {
      const last = g.econ.ledger[g.econ.ledger.length - 1];
      const v = last && last.ops > 0 ? last.fare / last.ops : 0;
      return { ok: v >= t.target, value: v / t.target, text: '上月票款/运营费用 ' + U.fmtPct(v, 0) + ' / 目标 ' + U.fmtPct(t.target, 0) + (t.sustain ? '（需连续 ' + t.sustain + ' 个月，已 ' + (t.streak || 0) + ' 个月）' : '') };
    }
    return { ok: false, value: 0, text: '' };
  };

  // Review samples belong to this exact input and are never reused after a change.
  Tasks.prototype.trafficReviewState=function(g){
    const m=g.model;let s=this._trafficReview;
    if(!s||s.net!==m.net||s.od!==m.od||s.year!==m.year||s.fare!==CM.Model.fareKey(m.fare)||s.ym!==g.ym())s=this._trafficReview={net:m.net,od:m.od,year:m.year,fare:CM.Model.fareKey(m.fare),ym:g.ym(),values:new Map()};
    return s;
  };
  Tasks.prototype.reviewValue=function(t,g){
    if(t.type==='ridership'){const d=g.model.dailyFor(Tasks.basisOf(t));return d?d.metro:null;}
    if(t.type==='facShare'){const f=CM.Fac.byId(t.fac),r=f&&Tasks.facShareOf(g.model,f,t.basis);return r?r.share:null;}
    if(t.type==='stationCrowd'){const i=g.compiled.sIndex.get(t.station),s=g.model.stDailyWk;return i===undefined||!s?null:(s.peak[i]||0)/CFG.metro.stationCap[g.compiled.stations[i].size];}
    if(t.type==='zoneCong'){
      if(t.metric!=='carShare')return g.zoneCong(t.zone,'wd');
      const a=(t.samples||[]).filter(x=>x.ym>=g.ym()-2&&x.ym<g.ym()).slice(-2);
      return(a.reduce((n,x)=>n+x.value,0)+g.model.zoneTraffic(t.zone).carShare)/(a.length+1);
    }
    return null;
  };
  Tasks.prototype.sampleTrafficReview=function(g){
    const s=this.trafficReviewState(g);
    for(const t of this.active)if(['zoneCong','stationCrowd','ridership','facShare'].includes(t.type)){
      const value=this.reviewValue(t,g);if(!Number.isFinite(value))continue;
      const a=s.values.get(t.id)||[];if(a.length&&a[a.length-1].cycle===g.model.cycles)continue;
      a.push({cycle:g.model.cycles,value});s.values.set(t.id,a.slice(-3));
    }
  };
  Tasks.prototype.reviewSafe=function(t,g){
    const a=this.trafficReviewState(g).values.get(t.id);if(!a||a.length<3)return false;
    const values=a.map(x=>x.value),last=values[values.length-1],spread=Math.max(...values)-Math.min(...values);
    const floor=t.type==='ridership'?Math.max(1,t.target*.02):((t.type==='stationCrowd'||(t.type==='zoneCong'&&t.metric!=='carShare'))?.03:.005);
    return Math.abs(last-t.target)>Math.max(floor,spread*2);
  };
  Tasks.prototype.startTrafficReview=function(t,g){
    g.model.reviewObserver=()=>this.sampleTrafficReview(g);this.sampleTrafficReview(g);return g.model.requestReview(Tasks.basisOf(t));
  };

  Tasks.prototype.nearTrafficThreshold=function(t,g,ev){
    const ym=g.ym();let near=ev.ok||ev.value>=.9||ym>=U.ymIndex(t.deadline[0],t.deadline[1]);
    if(t.type==='zoneCong'&&t.metric==='carShare'){
      const samples=(t.samples||[]).filter(x=>x.ym>=ym-2&&x.ym<ym).slice(-2),avg=(samples.reduce((n,x)=>n+x.value,0)+ev.sample)/(samples.length+1);
      near=near||avg<=t.target+.005;
    }
    return near;
  };
  Tasks.prototype.prepareTrafficReviews=function(g){
    if(!g.model.trafficReady())return;
    for(const t of this.active)if(t.evaluatedYM!==g.ym()&&['zoneCong','stationCrowd','ridership','facShare'].includes(t.type)){
      const basis=Tasks.basisOf(t);if(!g.model.trafficVerified(basis)&&this.nearTrafficThreshold(t,g,this.evaluate(t,g)))this.startTrafficReview(t,g);
    }
  };

  Tasks.prototype.monthly = function (g) {
    const y = g.clock.y, m = g.clock.m, ym = U.ymIndex(y, m);
    const out = [];
    const challenge = g.econ.mode === 'challenge';
    // 发布历史参考任务
    for (const h of D.histTasks) {
      if (this.issued[h.id]) continue;
      if (ym < U.ymIndex(h.appear[0], h.appear[1])) continue;
      this.issued[h.id] = 1;
      if (ym > U.ymIndex(h.deadline[0], h.deadline[1])) continue;
      const t = Object.assign({ kind: 'hist', status: 'active', issuedAt: [y, m], streak: 0 }, JSON.parse(JSON.stringify(h)));
      t.reward = h.reward * g.econ.costIndex(y);
      this.active.push(t);
      out.push({ type: 'issued', task: t });
    }
    // 动态任务（开局一年后开始）
    if (!this.nextDyn) this.nextDyn = ym + 12;
    if (!D.noDynTasks && ym >= this.nextDyn && this.active.filter(function (t) { return t.kind === 'dyn'; }).length < 2 && g.compiled.stations.length >= 0) {
      const t = this.generate(g);
      if (t) { this.active.push(t); out.push({ type: 'issued', task: t }); }
      this.nextDyn = ym + 6;
    }
    // 评估。交通模型升级过渡期（旧存档升级当月）：未达标时不清零连续月数，到期任务顺延 1 个月，不判失败
    const transit = g.inTransition ? g.inTransition(ym) : false;
    for (const t of this.active.slice()) {
      if(t.evaluatedYM===ym)continue;
      if(['zoneCong','stationCrowd','ridership','facShare'].includes(t.type)&&!g.model.trafficReady()){
        if(ym>=U.ymIndex(t.deadline[0],t.deadline[1])){const n=ym+1;t.deadline=[Math.floor(n/12),n%12+1];}
        g.taskRecheckYM=ym;t.graced='交通结果正在更新，保留进度并顺延到期评估';continue;
      }
      const ev = this.evaluate(t, g);
      if(['zoneCong','stationCrowd','ridership','facShare'].includes(t.type)){
        const near=this.nearTrafficThreshold(t,g,ev),basis=Tasks.basisOf(t);
        if(near&&!g.model.trafficVerified(basis)){
          this.startTrafficReview(t,g);
          if(!g.model.reviewComplete(basis)){g.taskRecheckYM=ym;t.graced='交通目标正在复核，暂不奖惩';continue;}
          // Strict stability or a clear margin outside recent variation permits a decision.
          if(!this.reviewSafe(t,g)){
            if(ym>=U.ymIndex(t.deadline[0],t.deadline[1])){const n=ym+1;t.deadline=[Math.floor(n/12),n%12+1];}
            t.graced='交通结果仍有波动，保留进度并顺延到期评估';continue;
          }
        }
      }
      delete t.graced;
      t.evaluatedYM=ym;
      t.progress = ev;
      let complete = false;
      if(t.type==='zoneCong'&&t.metric==='carShare'){
        t.samples=t.samples||[];if(!t.samples.length||t.samples[t.samples.length-1].ym!==ym)t.samples.push({ym,value:ev.sample});
        t.samples=t.samples.filter(x=>x.ym>=ym-2).slice(-3);const average=t.samples.reduce((v,x)=>v+x.value,0)/t.samples.length;
        ev.ok=t.samples.length>=3&&average<=t.target;ev.text+=' · 近 '+t.samples.length+' 个月平均 '+U.fmtPct(average,1);
        t.streak=t.samples.length;complete=ev.ok;
      }
      if (ev.ok) {
        t.streak = (t.streak || 0) + 1;
        if (!t.sustain || t.streak >= t.sustain) complete = true;
      } else if (!transit) t.streak = 0;
      if (!complete && transit && ym >= U.ymIndex(t.deadline[0], t.deadline[1])) {
        const nd = ym + 1; t.deadline = [Math.floor(nd / 12), nd % 12 + 1]; t.graced = '交通模型升级过渡：期限顺延 1 个月';
      }
      if (t.kind === 'dyn' && (complete || ym >= U.ymIndex(t.deadline[0], t.deadline[1]))) {
        this.cool = this.cool || {};
        this.cool[t.coolKey || t.type] = ym + (complete ? 24 : 36);
        this.cool['type:' + t.type] = ym + (complete ? 6 : 18);
      }
      if (complete) {
        t.status = 'done'; t.closedAt = [y, m];
        this.active.splice(this.active.indexOf(t), 1); this.done.push(t);
        if (challenge) { g.econ.income('reward', t.reward); g.econ.log('reward', t.reward, 'gen', '任务奖励：' + t.title, { y: y, m: m, d: 1 }); g.econ.mods.push({ kind: 'sat', delta: 4, until: ym + 5, reason: '完成任务「' + t.title + '」' }); }
        out.push({ type: 'done', task: t });
      } else if (ym >= U.ymIndex(t.deadline[0], t.deadline[1])) {
        t.status = 'failed'; t.closedAt = [y, m];
        this.active.splice(this.active.indexOf(t), 1); this.failed.push(t);
        if (challenge) {
          const E = CFG.economy;
          g.econ.mods.push({ kind: 'grant', factor: E.failGrantFactor, until: ym + E.failGrantMonths - 1, reason: '任务未完成：' + t.title });
          g.econ.mods.push({ kind: 'sat', delta: E.failSat, until: ym + E.failGrantMonths - 1, reason: '任务未完成：' + t.title });
        }
        out.push({ type: 'failed', task: t });
      }
    }
    if (this.done.length > 60) this.done.splice(0, this.done.length - 60);
    if (this.failed.length > 60) this.failed.splice(0, this.failed.length - 60);
    return out;
  };

  Tasks.prototype.generate = function (g) {
    const y = g.clock.y, m = g.clock.m, model = g.model, city = g.city;
    const acc = model.net ? model.net.acc : null;
    const ci = g.econ.costIndex(y) * (CFG.economy.rewardScale || 1);   // 奖励按本城价格水平
    const dl = function (months) { const t = U.ymIndex(y, m) + months; return [Math.floor(t / 12), t % 12 + 1]; };
    const rng = new U.RNG((y * 13 + m * 7 + this.seq * 31) >>> 0);
    const ym = U.ymIndex(y, m);
    const cool = this.cool || (this.cool = {});
    const active = this.active;
    const free = function (key, type) { return !(cool[key] > ym) && !(cool['type:' + type] > ym) && !active.some(function (t) { return (t.coolKey || t.type) === key; }); };
    const cands = [];
    // 可替代需求不足、尚未有可用地铁服务的片区优先发布覆盖任务。

    // 拥堵热点（排除近期出过任务的片区）
    let worst=-1,bestPotential=0;
    const zoneOpen=function(z){let n=0,o=0;for(const c of model.zoneCells[z]){if(city.landFrac[c]<.5)continue;n++;if(!city.cellLocked(c)&&!city.regions[city.region[c]].scenic)o++;}return n>0&&o>=n/2;};   // 可建设范围按格判断（v2.2）
    if(model.trafficReady())for(let z=0;z<model.Z;z++){
      if(model.zPop[z]+model.zJobs[z]<3000||!zoneOpen(z)||!free('cong:'+z,'zoneCong')||g.zoneCong(z)<1.25)continue;
      const v=model.zoneTraffic(z),potential=model.zoneOpportunity(z)/Math.max(1,v.trips);
      if(v.trips>100&&potential>=.06&&potential>bestPotential){worst=z;bestPotential=potential;}
    }
    if(worst>=0){
      const v=model.zoneTraffic(worst),drop=Math.min(.04,bestPotential*.2),target=Math.max(0,v.carShare-drop);
      cands.push({type:'zoneCong',metric:'carShare',coolKey:'cong:'+worst,zone:worst,start:v.carShare,target,sustain:3,samples:[],title:'减少「'+g.zoneName(worst)+'」高峰汽车出行',desc:'改善该片区居民出行的地铁直达性、换乘或票价，使工作日早高峰汽车出行占比降低 '+(drop*100).toFixed(1)+' 个百分点。按最近 3 个月平均值评估；过境车辆不计为本地出行。',months:30,reward:60000*ci});
    }
    // 覆盖空白
    if (acc) {
      let best = -1, bp = 0;
      for (let z = 0; z < model.Z; z++) {
        const p = model.zPop[z];
        if (p > bp && acc.zCov[z] < 0.2 && zoneOpen(z) && free('cov:' + z, 'zoneCov')) { bp = p; best = z; }
      }
      if (best >= 0 && bp > 12000) {
        cands.push({ type: 'zoneCov', coolKey: 'cov:' + best, zone: best, target: 0.5, title: '为「' + g.zoneName(best) + '」提供地铁服务', desc: '该片区人口约 ' + U.fmtPeople(bp) + '，尚无地铁覆盖。使片区 50% 以上的居民与岗位步行 15 分钟可达车站。', months: 30, reward: 50000 * ci });
      }
    }
    // 车站拥挤
    const sdw = model.stDailyWk || model.stDaily;
    if (sdw && !model.dailyStale && g.compiled.stations.length) {
      let bs = -1, br = 0;
      g.compiled.stations.forEach(function (s, i) {
        if (!free('st:' + s.id, 'stationCrowd')) return;
        const r = sdw.peak[i] / CFG.metro.stationCap[s.size];
        if (r > br) { br = r; bs = i; }
      });
      if (bs >= 0 && br > 1.0) {
        const s = g.compiled.stations[bs];
        cands.push({ type: 'stationCrowd', coolKey: 'st:' + s.id, station: s.id, start: br, target: 0.9, title: '缓解「' + s.name + '」车站拥挤', desc: '工作日高峰时段车站负荷已达 ' + U.fmtPct(br, 0) + '。可升级车站或分流客流，使高峰负荷降至 90% 以下。统计口径：工作日高峰小时。', months: 12, reward: 30000 * ci });
      }
    }
    // 客流增长
    if (model.daily && model.daily.metro > 20000 && free('ridership', 'ridership')) {
      cands.push({ type: 'ridership', basis: 'avg', target: Math.round(model.daily.metro * 1.2 / 1000) * 1000, title: '提升地铁客运量', desc: '在期限内使日均地铁客运量较当前提高 20%（可通过新线、延长线、换乘或调整票价实现）。统计口径：周平均（5 个工作日 + 2 个周末日）。', months: 24, reward: 40000 * ci });
    }
    // 经营：票款覆盖
    if (g.econ.mode === 'challenge' && model.daily && model.daily.metro > 50000 && free('recovery', 'recovery')) {
      cands.push({ type: 'recovery', target: 0.7, sustain: 3, title: '改善运营收支', desc: '连续 3 个月票款收入不低于运营费用的 70%。', months: 24, reward: 40000 * ci });
    }
    // 重要设施的地铁接驳（v1.9）：到访量较大、乘地铁比例很低的设施；口径按设施类型（见 Tasks.facBasis）
    if (model.facDaily && model.fn && model.net && g.compiled.stations.length) {
      let best = null;
      for (const f of model.fn.list) {
        if (!free('fac:' + f.id, 'facShare') || !Tasks.facServable(g.city, f)) continue;
        const basis = Tasks.facBasis(f), r = Tasks.facShareOf(model, f, basis);
        if (!r || r.vol < 3000 || r.share > 0.12) continue;
        const score = r.vol * (1 - r.share);
        if (!best || score > best.score) best = { f: f, basis: basis, r: r, score: score };
      }
      if (best) {
        // 目标随全市地铁分担率：至少比现在高 8 个百分点，并争取达到「全市分担率 + 6 个百分点」（上限 20%），线网尚小时也能完成
        const cs = (model.daily && model.daily.metroShare) || 0;
        const f = best.f, target = Math.round(Math.max(best.r.share + 0.08, Math.min(0.2, cs + 0.06)) * 100) / 100, bn = Tasks.BASIS[best.basis];
        const what = f.T.hub ? '接驳出行' : '到访出行';
        cands.push({ type: 'facShare', coolKey: 'fac:' + f.id, fac: f.id, basis: best.basis, start: best.r.share, target: target, title: '地铁服务「' + f.name + '」',
          desc: f.name + '（' + f.T.name + '）每天约有 ' + U.fmtPeople(best.r.vol) + ' 人次' + what + '（' + bn.replace(/（.*）/, '') + '），乘地铁的比例只有 ' + U.fmtPct(best.r.share, 0) + '。在附近设站并接入线网，使乘地铁的比例达到 ' + U.fmtPct(target, 0) + '。统计口径：' + bn + '。',
          months: 30, reward: 45000 * ci });
      }
    }
    // 本城专属动态任务（D.dynTasks）：在年份窗口内各发布一次，已满足的不发布
    const self = this;
    for (const tp of (D.dynTasks || []).concat(CM.Eras ? CM.Eras.goals() : [])) {   // v2.2：历史阶段目标同样作为本城任务，在阶段时间内发布
      if (this.issued['dyn:' + tp.id] || ym < U.ymIndex(tp.from[0], tp.from[1]) || ym > U.ymIndex(tp.to[0], tp.to[1]) || !free('city:' + tp.id, tp.type)) continue;
      const c = Object.assign({ coolKey: 'city:' + tp.id, cityId: tp.id }, JSON.parse(JSON.stringify(tp)), { reward: tp.reward * ci });
      delete c.from; delete c.to; delete c.id;
      if (this.evaluate(c, g).ok) continue;
      cands.push(c, c);   // 权重加倍，让本城任务更常出现
    }
    if (!cands.length) return null;
    const c = cands[Math.floor(rng.next() * cands.length)];
    if (c.cityId) self.issued['dyn:' + c.cityId] = 1;
    const t = Object.assign({ id: 'd' + (this.seq++), kind: 'dyn', status: 'active', issuedAt: [y, m], deadline: dl(c.months), streak: 0 }, c);
    return t;
  };

  Tasks.prototype.rebaseCongestion=function(g){
    for(const t of this.active.slice())if(t.type==='zoneCong'&&t.metric!=='carShare'){
      const v=g.model.zoneTraffic(t.zone),room=g.model.zoneOpportunity(t.zone)/Math.max(1,v.trips);
      t.legacyGoal={start:t.start,target:t.target,streak:t.streak||0,title:t.title,desc:t.desc,deadline:t.deadline&&t.deadline.slice(),progress:t.progress?JSON.parse(JSON.stringify(t.progress)):null};t.metric='carShare';t.start=v.carShare;t.target=Math.max(0,v.carShare-Math.min(.025,room*.15));t.samples=[];t.streak=0;
      t.title='减少「'+g.zoneName(t.zone)+'」高峰汽车出行';t.desc='降低片区工作日早高峰汽车出行占比，按最近 3 个月平均值评估。旧指标与历史进度已保留，重新建立评估窗口。';
      if(room<.015){
        const cov=g.model.net.acc.zCov[t.zone]||0;
        if(cov<.8){t.type='zoneCov';delete t.metric;delete t.sustain;t.start=cov;t.target=Math.min(.85,cov+.15);t.title='改善「'+g.zoneName(t.zone)+'」地铁覆盖';t.desc='该片区当前缺少可替代的地铁行程，目标调整为增加地铁覆盖，不要求消除无法控制的过境拥堵。';}
        else{t.status='withdrawn';t.closedAt=[g.clock.y,g.clock.m];this.active.splice(this.active.indexOf(t),1);this.adjusted=this.adjusted||[];this.adjusted.push(t);this.adjusted=this.adjusted.slice(-60);continue;}
      }
      const ym=Math.max(g.ym(),U.ymIndex(t.deadline[0],t.deadline[1]))+3;t.deadline=[Math.floor(ym/12),ym%12+1];t.graced='交通模型更新：旧目标保留在历史记录中，期限延长 3 个月，新评估窗口内不立即判失败';
    }
  };

  Tasks.prototype.serialize = function () { return { active: this.active, done: this.done, failed: this.failed, issued: this.issued, nextDyn: this.nextDyn, seq: this.seq, cool: this.cool || {}, adjusted:this.adjusted||[] }; };
  Tasks.restore = function (s) { const t = new Tasks(); Object.assign(t, s); return t; };
})(window.CM);
