export interface Patent {
  title: string
  number: string
  status: '发明' | '发明授权' | '实用新型'
  statusLabel: string
}

export const patents: Patent[] = [
  {
    title: '显示装置及显示方法、交通工具、存储介质和电子设备',
    number: '202011454971.5',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '双层成像抬头显示装置、抬头显示系统及交通设备',
    number: '202010851791.4',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '一种智能婴儿车的控制方法、智能婴儿车及控制系统',
    number: '201610565712.7',
    status: '发明授权',
    statusLabel: '发明授权',
  },
  {
    title: '一种智能轮椅及其控制方法',
    number: '201710510126.7',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '移动式机器人高度自适应底盘及自适应方法',
    number: '201710693807.1',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '一种智能设备人物识别的方法和装置',
    number: '201610674878.2',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '一种智能机器人的用户注册方法和装置',
    number: '201610670194.5',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '一种智能设备的语音交互控制方法和装置',
    number: '201610671251.1',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '一种服务机器人及其充电方法',
    number: '201710515791.5',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '送餐系统及送餐控制方法',
    number: '201710851788.0',
    status: '发明',
    statusLabel: '发明专利',
  },
  {
    title: '电梯全息控制装置及电梯',
    number: '202022170510.7',
    status: '实用新型',
    statusLabel: '实用新型（有权）',
  },
  {
    title: '车载全息显示装置及机动车',
    number: '202022155212.0',
    status: '实用新型',
    statusLabel: '实用新型（有权）',
  },
  {
    title: '一种服务机器人',
    number: '201720774116.X',
    status: '实用新型',
    statusLabel: '实用新型（有权）',
  },
  {
    title: '移动式机器人高度自适应底盘',
    number: '201721013612.X',
    status: '实用新型',
    statusLabel: '实用新型（有权）',
  },
]
