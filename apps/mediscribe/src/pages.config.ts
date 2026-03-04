import Dashboard from './pages/Dashboard';
import PatientHistory from './pages/PatientHistory';
import Patients from './pages/Patients';
import Index from './pages/Index';
import Appointments from './pages/Appointments';
import Home from './pages/Home';
import PatientTriage from './pages/PatientTriage';
import Settings from './pages/Settings';
import Notes from './pages/Notes';
import PatientPortal from './pages/PatientPortal';
import PatientBooking from './pages/PatientBooking';
import PatientTriageChat from './pages/PatientTriageChat';
import MyTriageHistory from './pages/MyTriageHistory';
import Demo from './pages/Demo';
import AssistantDashboard from './pages/AssistantDashboard';
import __Layout from './Layout';


export const PAGES = {
    "Dashboard": Dashboard,
    "PatientHistory": PatientHistory,
    "Patients": Patients,
    "Index": Index,
    "Appointments": Appointments,
    "Home": Home,
    "PatientTriage": PatientTriage,
    "Settings": Settings,
    "Notes": Notes,
    "PatientPortal": PatientPortal,
    "PatientBooking": PatientBooking,
    "PatientTriageChat": PatientTriageChat,
    "MyTriageHistory": MyTriageHistory,
    "Demo": Demo,
    "AssistantDashboard": AssistantDashboard,
}

export const pagesConfig = {
    mainPage: "AssistantDashboard",
    Pages: PAGES,
    Layout: __Layout,
};
