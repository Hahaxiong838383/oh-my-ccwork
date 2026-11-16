export default defineAppConfig({
  pages: ['pages/index/index'],
  permission: { 'scope.userLocation': { desc: '用于在系统要求时搜索附近读写台' } },
  window: {
    navigationStyle: 'custom',
    navigationBarTitleText: '小可 · 读写台',
    navigationBarBackgroundColor: '#f3f6f8',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f3f6f8',
  },
});
