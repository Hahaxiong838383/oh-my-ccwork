//! Unlike a bare JoinHandle, dropping this owner cannot detach a live child.
use std::{future::Future, pin::Pin, task::{Context, Poll}};
use tokio::task::{JoinError, JoinHandle};
pub struct OwnedTask<T>(JoinHandle<T>);
impl<T> OwnedTask<T> {
    pub fn new(task: JoinHandle<T>) -> Self { Self(task) }
    pub fn is_finished(&self) -> bool { self.0.is_finished() }
    pub fn abort_handle(&self) -> tokio::task::AbortHandle { self.0.abort_handle() }
    pub fn abort(&self) { self.0.abort(); }
}
impl<T> Future for OwnedTask<T> {
    type Output = Result<T, JoinError>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx)
    }
}
impl<T> Drop for OwnedTask<T> { fn drop(&mut self) { self.0.abort(); } }
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test] async fn dropping_running_owner_releases_nested_resources() {
        let (tx,rx)=tokio::sync::oneshot::channel::<()>();
        let (ready,started)=tokio::sync::oneshot::channel();
        let task=OwnedTask::new(tokio::spawn(async move {
            let _held=tx;let _=ready.send(());std::future::pending::<()>().await;
        }));
        started.await.unwrap();drop(task);
        assert!(tokio::time::timeout(std::time::Duration::from_secs(1),rx).await.unwrap().is_err());
    }
    #[tokio::test] async fn completed_prebuild_result_drops_its_asr_owner() {
        let (tx,rx)=tokio::sync::oneshot::channel::<()>();
        let child=OwnedTask::new(tokio::spawn(async move {let _held=tx;std::future::pending::<()>().await;}));
        let parent=OwnedTask::new(tokio::spawn(async move {child}));
        tokio::task::yield_now().await;drop(parent);
        assert!(tokio::time::timeout(std::time::Duration::from_secs(1),rx).await.unwrap().is_err());
    }
    #[tokio::test] async fn awaited_owner_transfers_result() {
        assert_eq!(OwnedTask::new(tokio::spawn(async {42})).await.unwrap(),42);
    }
}
