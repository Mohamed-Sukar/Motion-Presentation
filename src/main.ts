import './ui/styles/main.css';
import { MotionPresentationApp } from './ui/App';

const appRoot = document.getElementById('app');
if (appRoot) {
  new MotionPresentationApp(appRoot);
}
