import Home from './pages/Home';
import Tests from './pages/Tests';
import Cart from './pages/Cart';
import Reports from './pages/Reports';
import Profile from './pages/Profile';
import SymptomChecker from './pages/SymptomChecker';
import HealthCoach from './pages/HealthCoach';
import Insights from './pages/Insights';
import Vitals from './pages/Vitals';
import UploadReport from './pages/UploadReport';
import Defects from './pages/Defects';
import BookCollection from './pages/BookCollection';
import TrackOrder from './pages/TrackOrder';
import __Layout from './Layout';


export const PAGES = {
    "Home": Home,
    "Tests": Tests,
    "Cart": Cart,
    "Reports": Reports,
    "Profile": Profile,
    "SymptomChecker": SymptomChecker,
    "HealthCoach": HealthCoach,
    "Insights": Insights,
    "Vitals": Vitals,
    "UploadReport": UploadReport,
    "Defects": Defects,
    "BookCollection": BookCollection,
    "TrackOrder": TrackOrder,
}

export const pagesConfig = {
    mainPage: "SymptomChecker",
    Pages: PAGES,
    Layout: __Layout,
};
