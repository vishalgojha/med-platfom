/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import About from './pages/About';
import Achievements from './pages/Achievements';
import AdminDashboard from './pages/AdminDashboard';
import CancellationRefund from './pages/CancellationRefund';
import CareHub from './pages/CareHub';
import CaregiverDashboard from './pages/CaregiverDashboard';
import ClientPortal from './pages/ClientPortal';
import CoachDashboard from './pages/CoachDashboard';
import ContactUs from './pages/ContactUs';
import Dashboard from './pages/Dashboard';
import DoctorDashboard from './pages/DoctorDashboard';
import DoctorFeedback from './pages/DoctorFeedback';
import DoctorMessages from './pages/DoctorMessages';
import DoctorShare from './pages/DoctorShare';
import DoctorSummary from './pages/DoctorSummary';
import Documentation from './pages/Documentation';
import Documents from './pages/Documents';
import History from './pages/History';
import Home from './pages/Home';
import Landing from './pages/Landing';
import MarketingContent from './pages/MarketingContent';
import PatientDetail from './pages/PatientDetail';
import PatientFeedback from './pages/PatientFeedback';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Profile from './pages/Profile';
import Progress from './pages/Progress';
import Reports from './pages/Reports';
import Subscription from './pages/Subscription';
import Terms from './pages/Terms';
import WhatsAppTest from './pages/WhatsAppTest';
import __Layout from './Layout';


export const PAGES = {
    "About": About,
    "Achievements": Achievements,
    "AdminDashboard": AdminDashboard,
    "CancellationRefund": CancellationRefund,
    "CareHub": CareHub,
    "CaregiverDashboard": CaregiverDashboard,
    "ClientPortal": ClientPortal,
    "CoachDashboard": CoachDashboard,
    "ContactUs": ContactUs,
    "Dashboard": Dashboard,
    "DoctorDashboard": DoctorDashboard,
    "DoctorFeedback": DoctorFeedback,
    "DoctorMessages": DoctorMessages,
    "DoctorShare": DoctorShare,
    "DoctorSummary": DoctorSummary,
    "Documentation": Documentation,
    "Documents": Documents,
    "History": History,
    "Home": Home,
    "Landing": Landing,
    "MarketingContent": MarketingContent,
    "PatientDetail": PatientDetail,
    "PatientFeedback": PatientFeedback,
    "PrivacyPolicy": PrivacyPolicy,
    "Profile": Profile,
    "Progress": Progress,
    "Reports": Reports,
    "Subscription": Subscription,
    "Terms": Terms,
    "WhatsAppTest": WhatsAppTest,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};
